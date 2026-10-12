import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sendDynamoWrite } from '../../../packages/dynamodb/src/conflict-retry.js';
import { lifecycleHintItem } from '../../../packages/contracts/private/lifecycle-hint.js';
import {
  isRecordingCoverage,
  recordingCoverageKey,
  recordingSealingDurationMs,
  type RecordingCoverage,
} from '../../../packages/contracts/private/recording-coverage.js';
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isMonitorControlTimestamp } from '../../../packages/contracts/private/monitor-control.js';
import { recordingRetainUntil } from '../../../packages/contracts/private/recording-retention.js';
import type { SealedMonitorRecording } from './monitor-recorder.js';
import {
  isMonitorRecordingState,
  isStoredMonitorChunkReference as validReference,
  isMonitorLifecycleObservation,
  monitorObservationKey,
  monitorRecordingIncompleteReasons,
  type MonitorRecordingIncompleteReason,
  type MonitorRecordingStatus,
  type MonitorRecordingState,
  type MonitorLifecycleObservation,
} from '../../../packages/contracts/private/monitor-persistence.js';
export { isMonitorRecordingState, monitorRecordingIncompleteReasons };
export type { MonitorRecordingIncompleteReason, MonitorRecordingStatus, MonitorRecordingState };
import { isMonitorRecordingGeneration, isMonitorRecordingSessionId } from './monitor-recording-identity.js';
import type { StoredMonitorChunk } from './monitor-chunk-store.js';
import { isTerminalSealState } from '../../../packages/contracts/private/terminal-sealing.js';
import {
  isTerminalRecordingCheckpoint,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  initialCommandParser,
  isCommandParserCheckpoint,
} from '../../../packages/contracts/private/command-evidence.js';
import { isCaptureCoverage } from '../../../packages/contracts/private/capture-coverage.js';
import { isCaptureState } from '../../../packages/contracts/private/capture-persistence.js';
import {
  isMonitorEvidencePage,
  type MonitorEvidencePage,
} from '../../../packages/contracts/private/monitor-evidence.js';
import { canonicalJson } from '../../../packages/session/src/canonical.js';

export const monitorRecorderLease = Object.freeze({
  defaultDurationMs: 15_000,
  minimumDurationMs: 5_000,
  maximumDurationMs: 60_000,
});

export interface MonitorRecorderLease {
  sessionId: string;
  recorderId: string;
  generation: number;
}

export interface ClaimedMonitorRecording {
  lease: MonitorRecorderLease;
  state: MonitorRecordingState;
}

export interface ClaimMonitorRecording {
  sessionId: string;
  recorderId: string;
  now: string;
  leaseDurationMs?: number;
}

export interface MonitorRecordingStateStore {
  begin(lease: MonitorRecorderLease, startedAt: string, now: string, signal?: AbortSignal): Promise<void>;
  append(
    lease: MonitorRecorderLease,
    startedAt: string,
    reference: StoredMonitorChunk,
    now: string,
    signal?: AbortSignal,
    observation?: MonitorLifecycleObservation,
    evidence?: MonitorEvidencePage,
  ): Promise<void>;
  seal(
    lease: MonitorRecorderLease,
    value: SealedMonitorRecording,
    reference: StoredMonitorChunk,
    now: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface MonitorRecordingLifecycleStore {
  markIncomplete(
    sessionId: string,
    reason: MonitorRecordingIncompleteReason,
    completedAt: string,
    signal?: AbortSignal,
    expectedLease?: MonitorRecorderLease,
  ): Promise<void>;
}

export interface MonitorRecordingLeaseStore {
  get(sessionId: string, signal?: AbortSignal): Promise<MonitorRecordingState | undefined>;
  claim(value: ClaimMonitorRecording, signal?: AbortSignal): Promise<ClaimedMonitorRecording>;
  renew(
    lease: MonitorRecorderLease,
    now: string,
    leaseDurationMs?: number,
    signal?: AbortSignal,
  ): Promise<MonitorRecordingState>;
}

export type MonitorRecordingStoreErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'invalid_store'
  | 'invalid_state'
  | 'lease_unavailable'
  | 'recording_draining'
  | 'stale_lease';

const messages: Record<MonitorRecordingStoreErrorCode, string> = {
  invalid_config: 'Monitor recording store configuration is invalid.',
  invalid_input: 'Monitor recording store input is invalid.',
  invalid_store: 'Stored monitor recording data is invalid.',
  invalid_state: 'Monitor recording state does not permit this operation.',
  lease_unavailable: 'Monitor recording lease is not available.',
  recording_draining: 'Monitor recording has entered the drain phase.',
  stale_lease: 'Monitor recording lease is no longer valid.',
};

export class MonitorRecordingStoreError extends Error {
  constructor(readonly code: MonitorRecordingStoreErrorCode) {
    super(messages[code]);
    this.name = 'MonitorRecordingStoreError';
  }
}

const recorderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;

const recordingKey = (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: 'RECORDING' });
const sessionKey = (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: 'STATE' });

function chunkKey(sessionId: string, generation: number, reference: StoredMonitorChunk) {
  const generationSegment = String(generation).padStart(9, '0');
  const sequence = String(reference.nextSequence).padStart(6, '0');
  return { PK: `SESSION#${sessionId}`, SK: `CHUNK#${reference.source}#${generationSegment}#${sequence}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validSessionId(value: string): boolean {
  return isMonitorRecordingSessionId(value);
}

function validRecorderId(value: string): boolean {
  return recorderIdPattern.test(value);
}

function validIncompleteReason(value: unknown): value is MonitorRecordingIncompleteReason {
  return (monitorRecordingIncompleteReasons as readonly unknown[]).includes(value);
}

function validGeneration(value: number): boolean {
  return isMonitorRecordingGeneration(value);
}

function validLeaseDuration(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= monitorRecorderLease.minimumDurationMs &&
    value <= monitorRecorderLease.maximumDurationMs
  );
}

function expiresAt(now: string, durationMs: number): string {
  return new Date(Date.parse(now) + durationMs).toISOString();
}

function validLease(value: MonitorRecorderLease): boolean {
  return validSessionId(value.sessionId) && validRecorderId(value.recorderId) && validGeneration(value.generation);
}

function sameReference(left: StoredMonitorChunk | null, right: StoredMonitorChunk): boolean {
  return (
    left !== null &&
    left.phase === right.phase &&
    left.objectKey === right.objectKey &&
    left.sha256 === right.sha256 &&
    left.source === right.source &&
    left.after === right.after &&
    left.nextSequence === right.nextSequence &&
    left.frameCount === right.frameCount
  );
}

function sendOptions(signal?: AbortSignal): { abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

function conditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error && ['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error.name)
  );
}

function cloneState(value: MonitorRecordingState): MonitorRecordingState {
  return structuredClone(value);
}

export class DynamoMonitorRecordingStore
  implements MonitorRecordingStateStore, MonitorRecordingLifecycleStore, MonitorRecordingLeaseStore
{
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!tableNamePattern.test(table)) throw new MonitorRecordingStoreError('invalid_config');
  }

  async get(sessionId: string, signal?: AbortSignal): Promise<MonitorRecordingState | undefined> {
    if (!validSessionId(sessionId)) throw new MonitorRecordingStoreError('invalid_input');
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: recordingKey(sessionId), ConsistentRead: true }),
      sendOptions(signal),
    );
    if (!result.Item) return undefined;
    if (!isMonitorRecordingState(result.Item.data, sessionId)) throw new MonitorRecordingStoreError('invalid_store');
    return cloneState(result.Item.data);
  }

  async coverage(sessionId: string, signal?: AbortSignal): Promise<RecordingCoverage | undefined> {
    if (!validSessionId(sessionId)) throw new MonitorRecordingStoreError('invalid_input');
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: recordingCoverageKey(sessionId), ConsistentRead: true }),
      sendOptions(signal),
    );
    if (!result.Item) return undefined;
    if (!isRecordingCoverage(result.Item.data, sessionId)) throw new MonitorRecordingStoreError('invalid_store');
    return structuredClone(result.Item.data);
  }

  /** Commit task-independent coverage before copying terminal pages. The deadline changes atomically. */
  async cover(
    lease: MonitorRecorderLease,
    value: SealedMonitorRecording,
    reference: StoredMonitorChunk,
    terminal: TerminalRecordingCheckpoint,
    now: string,
    signal?: AbortSignal,
  ): Promise<RecordingCoverage> {
    if (!validLease(lease) || !isMonitorControlTimestamp(now)) throw new MonitorRecordingStoreError('invalid_input');
    const current = await this.get(lease.sessionId, signal);
    const saved = await this.coverage(lease.sessionId, signal);
    if (saved) {
      if (
        !current ||
        current.recorderId !== lease.recorderId ||
        current.generation !== lease.generation ||
        current.leaseExpiresAt! <= now
      )
        throw new MonitorRecordingStoreError('stale_lease');
      if (
        current.status !== 'draining' ||
        current.startedAt !== value.startedAt ||
        current.cutoffAt !== saved.cutoffAt ||
        saved.cutoffAt !== value.cutoffAt ||
        !isDeepStrictEqual(saved.terminal, terminal) ||
        !isDeepStrictEqual(saved.final, value.final) ||
        !sameReference(saved.monitor, reference) ||
        reference.source !== value.source ||
        reference.nextSequence !== value.cursor ||
        reference.frameCount !== value.frames.length ||
        current.drainDeadlineAt !== saved.sealingDeadlineAt ||
        now >= saved.sealingDeadlineAt
      )
        throw new MonitorRecordingStoreError('invalid_state');
      return saved;
    }
    if (
      !current ||
      current.status !== 'draining' ||
      current.cutoffAt !== value.cutoffAt ||
      current.startedAt !== value.startedAt ||
      current.recorderId !== lease.recorderId ||
      current.generation !== lease.generation ||
      current.leaseExpiresAt! <= now
    )
      throw new MonitorRecordingStoreError('stale_lease');
    if (
      !validReference(reference, lease.sessionId, lease.generation, 'sealed') ||
      reference.source !== value.source ||
      reference.nextSequence !== value.cursor ||
      value.frames.length !== value.cursor
    )
      throw new MonitorRecordingStoreError('invalid_input');
    const coverage: RecordingCoverage = {
      schemaVersion: 1,
      sessionId: lease.sessionId,
      cutoffAt: value.cutoffAt,
      coveredAt: now,
      taskDrainDeadlineAt: current.drainDeadlineAt!,
      sealingDeadlineAt: new Date(Date.parse(now) + recordingSealingDurationMs).toISOString(),
      terminal: structuredClone(terminal),
      monitor: structuredClone(reference),
      final: structuredClone(value.final),
    };
    if (!isRecordingCoverage(coverage, lease.sessionId)) throw new MonitorRecordingStoreError('invalid_input');
    const captureCoverage = (
      await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: { PK: `SESSION#${lease.sessionId}`, SK: 'CAPTURE_COVERAGE' },
          ConsistentRead: true,
        }),
        sendOptions(signal),
      )
    ).Item?.data;
    if (
      !isCaptureCoverage(captureCoverage) ||
      captureCoverage.cutoffAt !== value.cutoffAt ||
      !isDeepStrictEqual(captureCoverage.terminal, terminal)
    )
      throw new MonitorRecordingStoreError('invalid_state');
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        {
          ConditionCheck: {
            TableName: this.table,
            Key: { PK: `SESSION#${lease.sessionId}`, SK: 'CAPTURE_STATE' },
            ConditionExpression: '#data = :captures',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: { ':captures': captureCoverage.captures },
          },
        },
        {
          ConditionCheck: {
            TableName: this.table,
            Key: { PK: `SESSION#${lease.sessionId}`, SK: 'CAPTURE_COVERAGE' },
            ConditionExpression: '#data = :captures',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: { ':captures': captureCoverage },
          },
        },
        {
          ConditionCheck: {
            TableName: this.table,
            Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_RECORDING' },
            ConditionExpression: '#data = :terminal',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: { ':terminal': terminal },
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: recordingKey(lease.sessionId),
            UpdateExpression: 'SET #data.#deadline = :deadline',
            ConditionExpression:
              '#data.#status = :draining AND #data.#owner = :owner AND #data.#generation = :generation AND #data.#expires > :now AND #data.#cutoff = :cutoff AND #data.#deadline = :previousDeadline AND #data.#started = :started',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#deadline': 'drainDeadlineAt',
              '#status': 'status',
              '#owner': 'recorderId',
              '#generation': 'generation',
              '#expires': 'leaseExpiresAt',
              '#cutoff': 'cutoffAt',
              '#started': 'startedAt',
            },
            ExpressionAttributeValues: {
              ':draining': 'draining',
              ':owner': lease.recorderId,
              ':generation': lease.generation,
              ':now': now,
              ':cutoff': value.cutoffAt,
              ':started': value.startedAt,
              ':previousDeadline': current.drainDeadlineAt,
              ':deadline': coverage.sealingDeadlineAt,
            },
          },
        },
        {
          ConditionCheck: {
            TableName: this.table,
            Key: sessionKey(lease.sessionId),
            ConditionExpression: '#data.#view.#recording.#status = :draining',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#view': 'view',
              '#recording': 'recording',
              '#status': 'status',
            },
            ExpressionAttributeValues: { ':draining': 'draining' },
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: { ...recordingCoverageKey(lease.sessionId), data: coverage },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        { Put: { TableName: this.table, Item: lifecycleHintItem(lease.sessionId, 'coverage', now) } },
      ],
    });
    try {
      await sendDynamoWrite(this.client, command, sendOptions(signal));
      return coverage;
    } catch (error) {
      if (signal?.aborted) throw error;
      const recovered = await this.coverage(lease.sessionId, signal);
      if (recovered && isDeepStrictEqual(recovered, coverage)) return recovered;
      throw error;
    }
  }

  async claim(value: ClaimMonitorRecording, signal?: AbortSignal): Promise<ClaimedMonitorRecording> {
    const duration = value.leaseDurationMs ?? monitorRecorderLease.defaultDurationMs;
    if (
      !validSessionId(value.sessionId) ||
      !validRecorderId(value.recorderId) ||
      !isMonitorControlTimestamp(value.now) ||
      !validLeaseDuration(duration)
    ) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    const current = await this.get(value.sessionId, signal);
    if (current && current.status !== 'recording' && current.status !== 'draining') {
      throw new MonitorRecordingStoreError('invalid_state');
    }
    if (current?.status === 'draining' && Date.parse(current.drainDeadlineAt!) <= Date.parse(value.now)) {
      throw new MonitorRecordingStoreError('invalid_state');
    }
    if (
      current &&
      current.recorderId === value.recorderId &&
      Date.parse(current.leaseExpiresAt!) > Date.parse(value.now)
    ) {
      return this.claimed(value.sessionId, current);
    }
    if (
      current?.leaseExpiresAt !== null &&
      current !== undefined &&
      Date.parse(current.leaseExpiresAt) > Date.parse(value.now)
    ) {
      throw new MonitorRecordingStoreError('lease_unavailable');
    }
    const generation = current === undefined ? 1 : current.generation + 1;
    if (!validGeneration(generation)) throw new MonitorRecordingStoreError('invalid_state');
    let leaseExpiry = expiresAt(value.now, duration);
    if (current?.status === 'draining' && Date.parse(leaseExpiry) > Date.parse(current.drainDeadlineAt!)) {
      leaseExpiry = current.drainDeadlineAt!;
    }
    const next: MonitorRecordingState =
      current === undefined
        ? {
            schemaVersion: 1,
            status: 'recording',
            recorderId: value.recorderId,
            generation,
            leaseExpiresAt: leaseExpiry,
            startedAt: null,
            source: null,
            cursor: 0,
            cutoffAt: null,
            drainDeadlineAt: null,
            sealed: null,
            retainUntil: null,
            reason: null,
            updatedAt: value.now,
            completedAt: null,
          }
        : {
            ...current,
            recorderId: value.recorderId,
            generation,
            leaseExpiresAt: leaseExpiry,
            updatedAt: value.now,
          };
    const items =
      current === undefined
        ? [
            {
              Put: {
                TableName: this.table,
                Item: { ...recordingKey(value.sessionId), data: next },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: sessionKey(value.sessionId),
                UpdateExpression: 'SET #data.#view.#recording.#status = :recording',
                ConditionExpression:
                  'attribute_exists(PK) AND #data.#view.#status = :provisioning AND #data.#view.#recording.#status = :pending',
                ExpressionAttributeNames: {
                  '#data': 'data',
                  '#view': 'view',
                  '#status': 'status',
                  '#recording': 'recording',
                },
                ExpressionAttributeValues: {
                  ':provisioning': 'provisioning',
                  ':pending': 'pending',
                  ':recording': 'recording',
                },
              },
            },
          ]
        : [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: sessionKey(value.sessionId),
                ConditionExpression: '#data.#view.#recording.#status = :status',
                ExpressionAttributeNames: {
                  '#data': 'data',
                  '#view': 'view',
                  '#recording': 'recording',
                  '#status': 'status',
                },
                ExpressionAttributeValues: { ':status': current.status },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...recordingKey(value.sessionId), data: next },
                ConditionExpression: '#data = :current',
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: { ':current': current },
              },
            },
          ];
    try {
      await sendDynamoWrite(
        this.client,
        new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: items }),
        sendOptions(signal),
      );
      return this.claimed(value.sessionId, next);
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(value.sessionId, signal);
      if (
        saved &&
        saved.recorderId === value.recorderId &&
        saved.generation === generation &&
        Date.parse(saved.leaseExpiresAt!) > Date.parse(value.now)
      ) {
        return this.claimed(value.sessionId, saved);
      }
      if (conditionalFailure(error)) {
        const sessionStatus = await this.sessionRecordingStatus(value.sessionId, signal);
        if (sessionStatus === undefined || (saved !== undefined && sessionStatus !== saved.status)) {
          throw new MonitorRecordingStoreError('invalid_state');
        }
        if (saved && saved.status !== 'recording' && saved.status !== 'draining') {
          throw new MonitorRecordingStoreError('invalid_state');
        }
        throw new MonitorRecordingStoreError('lease_unavailable');
      }
      throw error;
    }
  }

  async renew(
    lease: MonitorRecorderLease,
    now: string,
    leaseDurationMs: number = monitorRecorderLease.defaultDurationMs,
    signal?: AbortSignal,
  ): Promise<MonitorRecordingState> {
    if (!validLease(lease) || !isMonitorControlTimestamp(now) || !validLeaseDuration(leaseDurationMs)) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    const current = await this.get(lease.sessionId, signal);
    if (!current) throw new MonitorRecordingStoreError('stale_lease');
    if (current.status !== 'recording' && current.status !== 'draining') {
      throw new MonitorRecordingStoreError('invalid_state');
    }
    if (
      current.recorderId !== lease.recorderId ||
      current.generation !== lease.generation ||
      Date.parse(current.leaseExpiresAt!) <= Date.parse(now)
    ) {
      throw new MonitorRecordingStoreError('stale_lease');
    }
    let nextExpiry = expiresAt(now, leaseDurationMs);
    if (current.status === 'draining') {
      if (Date.parse(current.drainDeadlineAt!) <= Date.parse(now)) {
        throw new MonitorRecordingStoreError('invalid_state');
      }
      if (Date.parse(nextExpiry) > Date.parse(current.drainDeadlineAt!)) nextExpiry = current.drainDeadlineAt!;
    }
    if (Date.parse(nextExpiry) <= Date.parse(current.leaseExpiresAt!)) return current;
    const command = new UpdateCommand({
      TableName: this.table,
      Key: recordingKey(lease.sessionId),
      UpdateExpression: 'SET #data.#leaseExpiresAt = :expiresAt, #data.#updatedAt = :now',
      ConditionExpression:
        '#data.#status = :status AND #data.#recorderId = :recorderId AND #data.#generation = :generation AND ' +
        '#data.#leaseExpiresAt = :currentExpiry',
      ExpressionAttributeNames: {
        '#data': 'data',
        '#status': 'status',
        '#recorderId': 'recorderId',
        '#generation': 'generation',
        '#leaseExpiresAt': 'leaseExpiresAt',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':status': current.status,
        ':recorderId': lease.recorderId,
        ':generation': lease.generation,
        ':currentExpiry': current.leaseExpiresAt,
        ':expiresAt': nextExpiry,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    });
    try {
      const result = await sendDynamoWrite(this.client, command, sendOptions(signal));
      if (!isMonitorRecordingState(result.Attributes?.data, lease.sessionId)) {
        throw new MonitorRecordingStoreError('invalid_store');
      }
      return cloneState(result.Attributes.data);
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(lease.sessionId, signal);
      if (
        saved &&
        saved.recorderId === lease.recorderId &&
        saved.generation === lease.generation &&
        Date.parse(saved.leaseExpiresAt!) >= Date.parse(nextExpiry)
      ) {
        return saved;
      }
      // Outcome can advance recording to draining between the read and update.
      // Re-read once through renew to cap the new expiry at the drain deadline.
      // This is bounded because draining cannot transition back to recording.
      if (
        conditionalFailure(error) &&
        current.status === 'recording' &&
        saved?.status === 'draining' &&
        saved.recorderId === lease.recorderId &&
        saved.generation === lease.generation &&
        saved.leaseExpiresAt! > now &&
        saved.drainDeadlineAt! > now
      )
        return this.renew(lease, now, leaseDurationMs, signal);
      if (conditionalFailure(error)) throw this.leaseOrStateError(saved, lease, now);
      throw error;
    }
  }

  async begin(lease: MonitorRecorderLease, startedAt: string, now: string, signal?: AbortSignal): Promise<void> {
    if (!validLease(lease) || !isMonitorControlTimestamp(startedAt) || !isMonitorControlTimestamp(now)) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    const command = new UpdateCommand({
      TableName: this.table,
      Key: recordingKey(lease.sessionId),
      UpdateExpression: 'SET #data.#startedAt = :startedAt, #data.#updatedAt = :now',
      ConditionExpression:
        '#data.#status = :recording AND #data.#recorderId = :recorderId AND #data.#generation = :generation AND ' +
        '#data.#leaseExpiresAt > :now AND (#data.#startedAt = :empty OR #data.#startedAt = :startedAt) AND ' +
        '#data.#source = :empty AND #data.#cursor = :zero',
      ExpressionAttributeNames: {
        '#data': 'data',
        '#status': 'status',
        '#recorderId': 'recorderId',
        '#generation': 'generation',
        '#leaseExpiresAt': 'leaseExpiresAt',
        '#startedAt': 'startedAt',
        '#source': 'source',
        '#cursor': 'cursor',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':recording': 'recording',
        ':recorderId': lease.recorderId,
        ':generation': lease.generation,
        ':now': now,
        ':startedAt': startedAt,
        ':empty': null,
        ':zero': 0,
      },
    });
    try {
      await sendDynamoWrite(this.client, command, sendOptions(signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(lease.sessionId, signal);
      if (
        saved?.recorderId === lease.recorderId &&
        saved.generation === lease.generation &&
        saved.startedAt === startedAt &&
        saved.source === null &&
        saved.cursor === 0
      ) {
        return;
      }
      if (conditionalFailure(error)) throw this.leaseOrStateError(saved, lease, now);
      throw error;
    }
  }

  async append(
    lease: MonitorRecorderLease,
    startedAt: string,
    reference: StoredMonitorChunk,
    now: string,
    signal?: AbortSignal,
    observation?: MonitorLifecycleObservation,
    evidence?: MonitorEvidencePage,
  ): Promise<void> {
    if (
      !validLease(lease) ||
      !isMonitorControlTimestamp(startedAt) ||
      !isMonitorControlTimestamp(now) ||
      !validReference(reference, lease.sessionId, lease.generation, 'live')
    ) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    // Source ordering is validated against its stream, not this process clock.
    if (
      observation !== undefined &&
      (!isMonitorLifecycleObservation(observation, lease.sessionId) ||
        observation.startedAt !== startedAt ||
        observation.source !== reference.source ||
        observation.cursor !== reference.nextSequence)
    )
      throw new MonitorRecordingStoreError('invalid_input');
    if (
      evidence !== undefined &&
      (!isMonitorEvidencePage(evidence) ||
        evidence.source !== reference.source ||
        evidence.after !== reference.after ||
        evidence.nextSequence !== reference.nextSequence ||
        evidence.events.some((item) => item.recordedAt < startedAt || item.recordedAt > now))
    )
      throw new MonitorRecordingStoreError('invalid_input');
    const previousObservation = observation
      ? (
          await this.client.send(
            new GetCommand({
              TableName: this.table,
              Key: monitorObservationKey(lease.sessionId),
              ConsistentRead: true,
            }),
            sendOptions(signal),
          )
        ).Item?.data
      : undefined;
    if (previousObservation !== undefined && !isMonitorLifecycleObservation(previousObservation, lease.sessionId))
      throw new MonitorRecordingStoreError('invalid_store');
    // Keep the first sustained recovery until the lifecycle fixes its outcome. A
    // lost callback must not let a later failing sample erase success evidence.
    const keepRecovery =
      isMonitorLifecycleObservation(previousObservation, lease.sessionId) &&
      previousObservation.recovery.state === 'met';
    if (
      observation &&
      isMonitorLifecycleObservation(previousObservation, lease.sessionId) &&
      !keepRecovery &&
      (previousObservation.source !== observation.source ||
        previousObservation.startedAt !== observation.startedAt ||
        previousObservation.cursor >= observation.cursor ||
        previousObservation.at > observation.at ||
        previousObservation.recovery.requiredSeconds !== observation.recovery.requiredSeconds)
    ) {
      if (await this.appendWasCommitted(lease.sessionId, lease.generation, reference, signal, evidence)) return;
      throw new MonitorRecordingStoreError('invalid_input');
    }
    const chunk = {
      schemaVersion: 1,
      kind: 'monitor_page',
      reference,
      committedAt: now,
    };
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        {
          Update: {
            TableName: this.table,
            Key: recordingKey(lease.sessionId),
            UpdateExpression: 'SET #data.#source = :source, #data.#cursor = :nextSequence, #data.#updatedAt = :now',
            ConditionExpression:
              '#data.#status = :recording AND #data.#recorderId = :recorderId AND #data.#generation = :generation AND ' +
              '#data.#leaseExpiresAt > :now AND #data.#startedAt = :startedAt AND #data.#cursor = :after AND ' +
              '(#data.#source = :source OR (#data.#source = :empty AND #data.#cursor = :zero))',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#status': 'status',
              '#recorderId': 'recorderId',
              '#generation': 'generation',
              '#leaseExpiresAt': 'leaseExpiresAt',
              '#startedAt': 'startedAt',
              '#source': 'source',
              '#cursor': 'cursor',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':recording': 'recording',
              ':recorderId': lease.recorderId,
              ':generation': lease.generation,
              ':now': now,
              ':startedAt': startedAt,
              ':source': reference.source,
              ':after': reference.after,
              ':nextSequence': reference.nextSequence,
              ':empty': null,
              ':zero': 0,
            },
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: { ...chunkKey(lease.sessionId, lease.generation, reference), data: chunk },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        ...(observation?.recovery.state === 'met' && !keepRecovery
          ? [{ Put: { TableName: this.table, Item: lifecycleHintItem(lease.sessionId, 'recovery_met', now) } }]
          : []),
        ...(evidence
          ? [
              {
                Put: {
                  TableName: this.table,
                  Item: {
                    PK: `SESSION#${lease.sessionId}`,
                    SK: `MONITOR_EVENTS#${String(reference.nextSequence).padStart(6, '0')}`,
                    data: structuredClone(evidence),
                  },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ]
          : []),
        ...(observation
          ? [
              keepRecovery
                ? {
                    ConditionCheck: {
                      TableName: this.table,
                      Key: monitorObservationKey(lease.sessionId),
                      ConditionExpression: '#data = :expected',
                      ExpressionAttributeNames: { '#data': 'data' },
                      ExpressionAttributeValues: { ':expected': previousObservation },
                    },
                  }
                : {
                    Put: {
                      TableName: this.table,
                      Item: { ...monitorObservationKey(lease.sessionId), data: observation },
                      ConditionExpression:
                        previousObservation === undefined ? 'attribute_not_exists(PK)' : '#data = :expected',
                      ...(previousObservation === undefined
                        ? {}
                        : {
                            ExpressionAttributeNames: { '#data': 'data' },
                            ExpressionAttributeValues: { ':expected': previousObservation },
                          }),
                    },
                  },
            ]
          : []),
      ],
    });
    try {
      await sendDynamoWrite(this.client, command, sendOptions(signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      if (await this.appendWasCommitted(lease.sessionId, lease.generation, reference, signal, evidence)) return;
      if (conditionalFailure(error)) {
        const saved = await this.get(lease.sessionId, signal);
        if (
          saved?.status === 'draining' &&
          saved.recorderId === lease.recorderId &&
          saved.generation === lease.generation &&
          Date.parse(saved.leaseExpiresAt!) > Date.parse(now)
        ) {
          throw new MonitorRecordingStoreError('recording_draining');
        }
        throw this.leaseOrStateError(saved, lease, now);
      }
      throw error;
    }
  }

  async seal(
    lease: MonitorRecorderLease,
    value: SealedMonitorRecording,
    reference: StoredMonitorChunk,
    now: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !validLease(lease) ||
      !isMonitorControlTimestamp(value.startedAt) ||
      !isMonitorControlTimestamp(value.cutoffAt) ||
      !isMonitorControlTimestamp(now) ||
      Date.parse(now) < Date.parse(value.cutoffAt) ||
      !validReference(reference, lease.sessionId, lease.generation, 'sealed') ||
      reference.source !== value.source ||
      reference.nextSequence !== value.cursor ||
      reference.frameCount !== value.frames.length
    ) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    await this.publishSeal(lease, value, reference, now, signal);
  }

  async finishCovered(
    lease: MonitorRecorderLease,
    coverage: RecordingCoverage,
    now: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!validLease(lease) || !isRecordingCoverage(coverage, lease.sessionId))
      throw new MonitorRecordingStoreError('invalid_input');
    const current = await this.get(lease.sessionId, signal);
    if (
      !current ||
      !current.startedAt ||
      current.cutoffAt !== coverage.cutoffAt ||
      current.drainDeadlineAt !== coverage.sealingDeadlineAt ||
      Number(coverage.monitor.objectKey.split('/')[3]) > current.generation
    )
      throw new MonitorRecordingStoreError('invalid_state');
    await this.publishSeal(
      lease,
      {
        startedAt: current.startedAt,
        cutoffAt: coverage.cutoffAt,
        source: coverage.monitor.source,
        cursor: coverage.monitor.nextSequence,
        final: coverage.final,
      },
      coverage.monitor,
      now,
      signal,
      coverage,
    );
  }

  private async publishSeal(
    lease: MonitorRecorderLease,
    value: Omit<SealedMonitorRecording, 'frames'>,
    reference: StoredMonitorChunk,
    now: string,
    signal?: AbortSignal,
    coverage?: RecordingCoverage,
  ): Promise<void> {
    if (!validLease(lease) || !isMonitorControlTimestamp(now) || now < value.cutoffAt)
      throw new MonitorRecordingStoreError('invalid_input');
    const terminal = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_RECORDING' },
        ConsistentRead: true,
      }),
      sendOptions(signal),
    );
    const terminalSeal = terminal.Item
      ? await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_SEAL' },
            ConsistentRead: true,
          }),
          sendOptions(signal),
        )
      : undefined;
    if (
      terminal.Item &&
      (!isTerminalRecordingCheckpoint(terminal.Item.data) ||
        !isTerminalSealState(terminalSeal?.Item?.data) ||
        !terminalSeal.Item.data.complete ||
        terminalSeal.Item.data.cutoffAt !== value.cutoffAt ||
        terminalSeal.Item.data.checkpoint.metadata.source !== terminal.Item.data.metadata.source ||
        terminalSeal.Item.data.checkpoint.cursor > terminal.Item.data.cursor)
    )
      throw new MonitorRecordingStoreError('invalid_state');
    if (
      coverage &&
      (!isDeepStrictEqual(terminal.Item?.data, coverage.terminal) ||
        !isDeepStrictEqual(terminalSeal?.Item?.data?.checkpoint, coverage.terminal))
    )
      throw new MonitorRecordingStoreError('invalid_state');
    const evidenceItems = terminal.Item
      ? await Promise.all(
          ['COMMAND_PARSER', 'CAPTURE_STATE', 'SEALED_COMMAND_PARSER', 'CAPTURE_COVERAGE'].map(async (SK) => {
            const result = await this.client.send(
              new GetCommand({
                TableName: this.table,
                Key: { PK: `SESSION#${lease.sessionId}`, SK },
                ConsistentRead: true,
              }),
              sendOptions(signal),
            );
            return { SK, data: result.Item?.data as unknown };
          }),
        )
      : [];
    if (terminal.Item) {
      const parser = evidenceItems[0]?.data;
      const captures = evidenceItems[1]?.data;
      const sealedParser = evidenceItems[2]?.data;
      const sealCursor = terminalSeal?.Item?.data?.cursor as number;
      const captureCoverage = evidenceItems[3]?.data;
      if (
        coverage &&
        (!isCaptureCoverage(captureCoverage) ||
          captureCoverage.cutoffAt !== coverage.cutoffAt ||
          !isDeepStrictEqual(captureCoverage.captures, captures) ||
          !isDeepStrictEqual(captureCoverage.terminal, coverage.terminal) ||
          !isDeepStrictEqual(
            captureCoverage.parser,
            sealedParser ?? initialCommandParser(coverage.terminal.metadata.source),
          ))
      )
        throw new MonitorRecordingStoreError('invalid_state');
      if (
        (sealedParser === undefined
          ? sealCursor !== 0
          : !isCommandParserCheckpoint(sealedParser) ||
            sealedParser.cursor !== sealCursor ||
            sealedParser.source !== terminal.Item.data.metadata.source ||
            sealedParser.lossAt !== null ||
            sealedParser.mode !== 'text' ||
            sealedParser.utf8Tail !== '' ||
            (sealCursor === 0 && sealedParser.count !== 0)) ||
        !isCommandParserCheckpoint(parser) ||
        parser.source !== terminal.Item.data.metadata.source ||
        parser.cursor !== terminal.Item.data.cursor ||
        (parser.lossAt !== null && parser.lossAt <= value.cutoffAt) ||
        !isCaptureState(captures) ||
        captures.unavailable ||
        captures.baseline.unavailable ||
        captures.sequence !== captures.cursor ||
        captures.cursor < (isCommandParserCheckpoint(sealedParser) ? sealedParser.count : 0)
      )
        throw new MonitorRecordingStoreError('invalid_state');
    }
    const terminalConditions = [
      {
        ConditionCheck: {
          TableName: this.table,
          Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_RECORDING' },
          ...(terminal.Item
            ? {
                ConditionExpression: '#data = :terminal',
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: { ':terminal': terminal.Item.data },
              }
            : { ConditionExpression: 'attribute_not_exists(PK)' }),
        },
      },
      ...(terminalSeal?.Item
        ? [
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_SEAL' },
                ConditionExpression: '#data = :seal',
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: { ':seal': terminalSeal.Item.data },
              },
            },
          ]
        : []),
    ];
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        ...terminalConditions,
        ...(coverage
          ? [
              {
                ConditionCheck: {
                  TableName: this.table,
                  Key: recordingCoverageKey(lease.sessionId),
                  ConditionExpression: '#data = :coverage',
                  ExpressionAttributeNames: { '#data': 'data' },
                  ExpressionAttributeValues: { ':coverage': coverage },
                },
              },
            ]
          : []),
        { Put: { TableName: this.table, Item: lifecycleHintItem(lease.sessionId, 'complete', now) } },
        ...evidenceItems.map(({ SK, data }) => ({
          ConditionCheck: {
            TableName: this.table,
            Key: { PK: `SESSION#${lease.sessionId}`, SK },
            ...(data === undefined
              ? { ConditionExpression: 'attribute_not_exists(PK)' }
              : {
                  ConditionExpression: '#data = :expected',
                  ExpressionAttributeNames: { '#data': 'data' },
                  ExpressionAttributeValues: { ':expected': data },
                }),
          },
        })),
        {
          Update: {
            TableName: this.table,
            Key: recordingKey(lease.sessionId),
            UpdateExpression:
              'SET #data.#status = :complete, #data.#source = :source, #data.#cursor = :cursor, ' +
              '#data.#sealed = :sealed, #data.#reason = :empty, #data.#recorderId = :empty, ' +
              '#data.#leaseExpiresAt = :empty, #data.#retainUntil = :retainUntil, ' +
              '#data.#updatedAt = :now, #data.#completedAt = :now',
            ConditionExpression:
              '#data.#status = :draining AND #data.#recorderId = :recorderId AND #data.#generation = :generation AND ' +
              '#data.#leaseExpiresAt > :now AND #data.#startedAt = :startedAt AND #data.#cutoffAt = :cutoffAt AND ' +
              '#data.#drainDeadlineAt > :now',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#status': 'status',
              '#source': 'source',
              '#cursor': 'cursor',
              '#sealed': 'sealed',
              '#reason': 'reason',
              '#recorderId': 'recorderId',
              '#generation': 'generation',
              '#leaseExpiresAt': 'leaseExpiresAt',
              '#retainUntil': 'retainUntil',
              '#updatedAt': 'updatedAt',
              '#completedAt': 'completedAt',
              '#startedAt': 'startedAt',
              '#cutoffAt': 'cutoffAt',
              '#drainDeadlineAt': 'drainDeadlineAt',
            },
            ExpressionAttributeValues: {
              ':complete': 'complete',
              ':draining': 'draining',
              ':source': value.source,
              ':cursor': value.cursor,
              ':sealed': reference,
              ':empty': null,
              ':recorderId': lease.recorderId,
              ':generation': lease.generation,
              ':now': now,
              ':retainUntil': recordingRetainUntil(value.cutoffAt, 'sealed'),
              ':startedAt': value.startedAt,
              ':cutoffAt': value.cutoffAt,
            },
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: sessionKey(lease.sessionId),
            UpdateExpression: 'SET #data.#view.#recording.#status = :complete, #data.#view.#recording.#reason = :empty',
            ConditionExpression: '#data.#view.#recording.#status = :draining',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#view': 'view',
              '#recording': 'recording',
              '#status': 'status',
              '#reason': 'reason',
            },
            ExpressionAttributeValues: { ':complete': 'complete', ':draining': 'draining', ':empty': null },
          },
        },
      ],
    });
    try {
      await sendDynamoWrite(this.client, command, sendOptions(signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      const [saved, publicStatus] = await Promise.all([
        this.get(lease.sessionId, signal),
        this.sessionRecordingStatus(lease.sessionId, signal),
      ]);
      if (
        saved?.status === 'complete' &&
        saved.startedAt === value.startedAt &&
        saved.cutoffAt === value.cutoffAt &&
        saved.source === value.source &&
        saved.cursor === value.cursor &&
        sameReference(saved.sealed, reference) &&
        publicStatus === 'complete' &&
        (coverage === undefined || isDeepStrictEqual(await this.coverage(lease.sessionId, signal), coverage))
      ) {
        return;
      }
      if (conditionalFailure(error)) throw this.leaseOrStateError(saved, lease, now);
      throw error;
    }
  }

  async markIncomplete(
    sessionId: string,
    reason: MonitorRecordingIncompleteReason,
    completedAt: string,
    signal?: AbortSignal,
    expectedLease?: MonitorRecorderLease,
  ): Promise<void> {
    if (
      !validSessionId(sessionId) ||
      !validIncompleteReason(reason) ||
      !isMonitorControlTimestamp(completedAt) ||
      (expectedLease && (!validLease(expectedLease) || expectedLease.sessionId !== sessionId))
    ) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    expectedLease = expectedLease ? { ...expectedLease } : undefined;
    const current = await this.get(sessionId, signal);
    if (!current) throw new MonitorRecordingStoreError('invalid_state');
    if (
      expectedLease &&
      (!validLease(expectedLease) ||
        expectedLease.sessionId !== sessionId ||
        current.recorderId !== expectedLease.recorderId ||
        current.generation !== expectedLease.generation ||
        current.leaseExpiresAt === null ||
        current.leaseExpiresAt <= completedAt)
    )
      throw new MonitorRecordingStoreError('stale_lease');
    if (current.status === 'incomplete') {
      const publicRecording = await this.sessionRecordingState(sessionId, signal);
      if (current.reason === reason && publicRecording?.status === 'incomplete' && publicRecording.reason === reason) {
        return;
      }
      throw new MonitorRecordingStoreError('invalid_state');
    }
    if (current.status !== 'recording' && current.status !== 'draining') {
      throw new MonitorRecordingStoreError('invalid_state');
    }
    if (
      current.status === 'draining' &&
      current.cutoffAt !== null &&
      Date.parse(completedAt) < Date.parse(current.cutoffAt)
    ) {
      throw new MonitorRecordingStoreError('invalid_input');
    }
    if (
      reason === 'drain_timeout' &&
      (current.status !== 'draining' || Date.parse(completedAt) < Date.parse(current.drainDeadlineAt!))
    ) {
      throw new MonitorRecordingStoreError('invalid_state');
    }
    const next: MonitorRecordingState = {
      ...current,
      status: 'incomplete',
      recorderId: null,
      leaseExpiresAt: null,
      cutoffAt: current.cutoffAt ?? completedAt,
      drainDeadlineAt: current.drainDeadlineAt ?? completedAt,
      sealed: null,
      retainUntil: recordingRetainUntil(current.startedAt ?? completedAt, 'provisional'),
      reason,
      updatedAt: completedAt,
      completedAt,
    };
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        { Put: { TableName: this.table, Item: lifecycleHintItem(sessionId, 'incomplete', completedAt) } },
        {
          Put: {
            TableName: this.table,
            Item: { ...recordingKey(sessionId), data: next },
            ConditionExpression: '#data = :current',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: { ':current': current },
          },
        },
        {
          Update: {
            TableName: this.table,
            Key: sessionKey(sessionId),
            UpdateExpression:
              'SET #data.#view.#recording.#status = :incomplete, #data.#view.#recording.#reason = :reason',
            ConditionExpression:
              'attribute_exists(PK) AND ' +
              '(#data.#view.#status = :resolved OR #data.#view.#status = :failed OR ' +
              '#data.#view.#status = :ended OR #data.#view.#status = :abandoned OR #data.#view.#status = :error) AND ' +
              '#data.#view.#recording.#status = :currentStatus AND #data.#view.#recording.#reason = :empty',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#view': 'view',
              '#status': 'status',
              '#recording': 'recording',
              '#reason': 'reason',
            },
            ExpressionAttributeValues: {
              ':resolved': 'resolved',
              ':failed': 'failed',
              ':ended': 'ended',
              ':abandoned': 'abandoned',
              ':error': 'error',
              ':currentStatus': current.status,
              ':empty': null,
              ':incomplete': 'incomplete',
              ':reason': reason,
            },
          },
        },
      ],
    });
    try {
      await sendDynamoWrite(this.client, command, sendOptions(signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      const [saved, publicRecording] = await Promise.all([
        this.get(sessionId, signal),
        this.sessionRecordingState(sessionId, signal),
      ]);
      if (
        saved?.status === 'incomplete' &&
        saved.reason === reason &&
        publicRecording?.status === 'incomplete' &&
        publicRecording.reason === reason
      ) {
        return;
      }
      if (conditionalFailure(error)) throw new MonitorRecordingStoreError('invalid_state');
      throw error;
    }
  }

  private claimed(sessionId: string, state: MonitorRecordingState): ClaimedMonitorRecording {
    return {
      lease: { sessionId, recorderId: state.recorderId!, generation: state.generation },
      state: cloneState(state),
    };
  }

  private leaseOrStateError(
    state: MonitorRecordingState | undefined,
    lease: MonitorRecorderLease,
    now: string,
  ): MonitorRecordingStoreError {
    if (
      !state ||
      state.recorderId !== lease.recorderId ||
      state.generation !== lease.generation ||
      state.leaseExpiresAt === null ||
      Date.parse(state.leaseExpiresAt) <= Date.parse(now)
    ) {
      return new MonitorRecordingStoreError('stale_lease');
    }
    return new MonitorRecordingStoreError('invalid_state');
  }

  private async appendWasCommitted(
    sessionId: string,
    generation: number,
    reference: StoredMonitorChunk,
    signal?: AbortSignal,
    evidence?: MonitorEvidencePage,
  ): Promise<boolean> {
    const [state, chunk] = await Promise.all([
      this.get(sessionId, signal),
      this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: chunkKey(sessionId, generation, reference),
          ConsistentRead: true,
        }),
        sendOptions(signal),
      ),
    ]);
    const data = chunk.Item?.data;
    if (evidence) {
      const saved = await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: { PK: `SESSION#${sessionId}`, SK: `MONITOR_EVENTS#${String(reference.nextSequence).padStart(6, '0')}` },
          ConsistentRead: true,
        }),
        sendOptions(signal),
      );
      if (canonicalJson(saved.Item?.data) !== canonicalJson(evidence)) return false;
    }
    return (
      state !== undefined &&
      state.generation === generation &&
      state.source === reference.source &&
      state.cursor >= reference.nextSequence &&
      isRecord(data) &&
      data.schemaVersion === 1 &&
      data.kind === 'monitor_page' &&
      validReference(data.reference, sessionId, generation, 'live') &&
      sameReference(data.reference, reference) &&
      isMonitorControlTimestamp(data.committedAt)
    );
  }

  private async sessionRecordingStatus(sessionId: string, signal?: AbortSignal): Promise<string | undefined> {
    return (await this.sessionRecordingState(sessionId, signal))?.status;
  }

  private async sessionRecordingState(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ status: string; reason: string | null } | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: sessionKey(sessionId), ConsistentRead: true }),
      sendOptions(signal),
    );
    const data = result.Item?.data;
    if (!isRecord(data) || !isRecord(data.view) || !isRecord(data.view.recording)) return undefined;
    const status = data.view.recording.status;
    const reason = data.view.recording.reason;
    if (typeof status !== 'string' || (reason !== null && typeof reason !== 'string')) return undefined;
    return { status, reason };
  }
}
