import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  isMonitorControlSource,
  isMonitorControlTimestamp,
  monitorControlSchema,
} from '../../../packages/contracts/private/monitor-control.js';
import type { MonitorRecordingCheckpoint, SealedMonitorRecording } from './monitor-recorder.js';
import type { StoredMonitorChunk } from './monitor-chunk-store.js';

export const monitorRecorderLease = Object.freeze({
  defaultDurationMs: 15_000,
  minimumDurationMs: 5_000,
  maximumDurationMs: 60_000,
});

export type MonitorRecordingStatus = 'recording' | 'draining' | 'complete' | 'incomplete';

export interface MonitorRecordingState extends MonitorRecordingCheckpoint {
  schemaVersion: 1;
  status: MonitorRecordingStatus;
  recorderId: string | null;
  generation: number;
  leaseExpiresAt: string | null;
  cutoffAt: string | null;
  drainDeadlineAt: string | null;
  sealed: StoredMonitorChunk | null;
  reason: string | null;
  updatedAt: string;
  completedAt: string | null;
}

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
  ): Promise<void>;
  seal(
    lease: MonitorRecorderLease,
    value: SealedMonitorRecording,
    reference: StoredMonitorChunk,
    now: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type MonitorRecordingStoreErrorCode =
  'invalid_config' | 'invalid_input' | 'invalid_store' | 'invalid_state' | 'lease_unavailable' | 'stale_lease';

const messages: Record<MonitorRecordingStoreErrorCode, string> = {
  invalid_config: 'Monitor recording store configuration is invalid.',
  invalid_input: 'Monitor recording store input is invalid.',
  invalid_store: 'Stored monitor recording data is invalid.',
  invalid_state: 'Monitor recording state does not permit this operation.',
  lease_unavailable: 'Monitor recording lease is not available.',
  stale_lease: 'Monitor recording lease is no longer valid.',
};

export class MonitorRecordingStoreError extends Error {
  constructor(readonly code: MonitorRecordingStoreErrorCode) {
    super(messages[code]);
    this.name = 'MonitorRecordingStoreError';
  }
}

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recorderIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const maximumGeneration = 999_999_999;
const maximumFrames = 10_000;

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

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validSessionId(value: string): boolean {
  return sessionIdPattern.test(value);
}

function validRecorderId(value: string): boolean {
  return recorderIdPattern.test(value);
}

function validGeneration(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= maximumGeneration;
}

function validCursor(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximumFrames && value <= monitorControlSchema.maximumCursor;
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

function referenceGeneration(objectKey: string): number {
  const match = /^sessions\/[0-9a-f-]+\/metrics\/([0-9]{9})\//.exec(objectKey);
  return match ? Number(match[1]) : Number.NaN;
}

function validReference(
  value: unknown,
  sessionId: string,
  generation: number,
  phase: StoredMonitorChunk['phase'],
): value is StoredMonitorChunk {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['phase', 'objectKey', 'sha256', 'source', 'after', 'nextSequence', 'frameCount'])
  ) {
    return false;
  }
  if (
    value.phase !== phase ||
    typeof value.objectKey !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !sha256Pattern.test(value.sha256) ||
    !validCursor(value.after as number) ||
    !validCursor(value.nextSequence as number) ||
    !Number.isInteger(value.frameCount) ||
    (value.frameCount as number) < 0 ||
    (value.frameCount as number) > maximumFrames
  ) {
    return false;
  }
  const source = value.source;
  if (source !== null && !isMonitorControlSource(source)) return false;
  const after = value.after as number;
  const nextSequence = value.nextSequence as number;
  const frameCount = value.frameCount as number;
  const firstSequence = frameCount === 0 ? 0 : after + 1;
  const expectedKey =
    `sessions/${sessionId}/metrics/${String(generation).padStart(9, '0')}/${phase}/${source ?? 'empty'}/` +
    `${String(firstSequence).padStart(6, '0')}-${String(nextSequence).padStart(6, '0')}-${value.sha256}.json`;
  if (referenceGeneration(value.objectKey) !== generation || value.objectKey !== expectedKey) {
    return false;
  }
  if (phase === 'live') {
    return (
      source !== null &&
      frameCount >= 1 &&
      frameCount <= monitorControlSchema.maximumFramesPerPage &&
      nextSequence > after &&
      nextSequence - after === frameCount
    );
  }
  return after === 0 && nextSequence === frameCount && (frameCount === 0 ? source === null : source !== null);
}

function validCheckpoint(state: MonitorRecordingState): boolean {
  return (
    validCursor(state.cursor) &&
    (state.startedAt === null || isMonitorControlTimestamp(state.startedAt)) &&
    (state.source === null || isMonitorControlSource(state.source)) &&
    (state.startedAt === null
      ? state.source === null && state.cursor === 0
      : state.cursor === 0
        ? state.source === null
        : state.source !== null)
  );
}

function validState(value: unknown, sessionId: string): value is MonitorRecordingState {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'recorderId',
      'generation',
      'leaseExpiresAt',
      'startedAt',
      'source',
      'cursor',
      'cutoffAt',
      'drainDeadlineAt',
      'sealed',
      'reason',
      'updatedAt',
      'completedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    !['recording', 'draining', 'complete', 'incomplete'].includes(value.status as string) ||
    !validGeneration(value.generation as number) ||
    !isMonitorControlTimestamp(value.updatedAt)
  ) {
    return false;
  }
  const state = value as unknown as MonitorRecordingState;
  if (!validCheckpoint(state)) return false;
  if (
    (state.cutoffAt !== null && !isMonitorControlTimestamp(state.cutoffAt)) ||
    (state.drainDeadlineAt !== null && !isMonitorControlTimestamp(state.drainDeadlineAt)) ||
    (state.completedAt !== null && !isMonitorControlTimestamp(state.completedAt)) ||
    (state.reason !== null && (typeof state.reason !== 'string' || state.reason.length < 1 || state.reason.length > 80))
  ) {
    return false;
  }
  if (state.status === 'recording') {
    return (
      state.recorderId !== null &&
      validRecorderId(state.recorderId) &&
      state.leaseExpiresAt !== null &&
      isMonitorControlTimestamp(state.leaseExpiresAt) &&
      state.cutoffAt === null &&
      state.drainDeadlineAt === null &&
      state.sealed === null &&
      state.reason === null &&
      state.completedAt === null
    );
  }
  if (state.status === 'draining') {
    return (
      state.recorderId !== null &&
      validRecorderId(state.recorderId) &&
      state.leaseExpiresAt !== null &&
      isMonitorControlTimestamp(state.leaseExpiresAt) &&
      state.cutoffAt !== null &&
      state.drainDeadlineAt !== null &&
      Date.parse(state.drainDeadlineAt) >= Date.parse(state.cutoffAt) &&
      state.sealed === null &&
      state.reason === null &&
      state.completedAt === null
    );
  }
  if (
    state.recorderId !== null ||
    state.leaseExpiresAt !== null ||
    state.cutoffAt === null ||
    state.drainDeadlineAt === null ||
    state.completedAt === null
  ) {
    return false;
  }
  if (
    Date.parse(state.drainDeadlineAt) < Date.parse(state.cutoffAt) ||
    Date.parse(state.completedAt) < Date.parse(state.cutoffAt)
  ) {
    return false;
  }
  if (state.status === 'complete') {
    return (
      state.reason === null &&
      Date.parse(state.completedAt) < Date.parse(state.drainDeadlineAt) &&
      validReference(state.sealed, sessionId, state.generation, 'sealed') &&
      state.sealed.source === state.source &&
      state.sealed.nextSequence === state.cursor &&
      state.sealed.frameCount === state.cursor
    );
  }
  return state.sealed === null && state.reason !== null;
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

export class DynamoMonitorRecordingStore implements MonitorRecordingStateStore {
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
    if (!validState(result.Item.data, sessionId)) throw new MonitorRecordingStoreError('invalid_store');
    return cloneState(result.Item.data);
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
      await this.client.send(
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
      const result = await this.client.send(command, sendOptions(signal));
      if (!validState(result.Attributes?.data, lease.sessionId)) throw new MonitorRecordingStoreError('invalid_store');
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
      await this.client.send(command, sendOptions(signal));
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
  ): Promise<void> {
    if (
      !validLease(lease) ||
      !isMonitorControlTimestamp(startedAt) ||
      !isMonitorControlTimestamp(now) ||
      !validReference(reference, lease.sessionId, lease.generation, 'live')
    ) {
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
      ],
    });
    try {
      await this.client.send(command, sendOptions(signal));
    } catch (error) {
      if (signal?.aborted) throw error;
      if (await this.appendWasCommitted(lease.sessionId, lease.generation, reference, signal)) return;
      if (conditionalFailure(error)) {
        const saved = await this.get(lease.sessionId, signal);
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
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        {
          Update: {
            TableName: this.table,
            Key: recordingKey(lease.sessionId),
            UpdateExpression:
              'SET #data.#status = :complete, #data.#source = :source, #data.#cursor = :cursor, ' +
              '#data.#sealed = :sealed, #data.#reason = :empty, #data.#recorderId = :empty, ' +
              '#data.#leaseExpiresAt = :empty, #data.#updatedAt = :now, #data.#completedAt = :now',
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
      await this.client.send(command, sendOptions(signal));
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
        publicStatus === 'complete'
      ) {
        return;
      }
      if (conditionalFailure(error)) throw this.leaseOrStateError(saved, lease, now);
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
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: sessionKey(sessionId), ConsistentRead: true }),
      sendOptions(signal),
    );
    const data = result.Item?.data;
    if (!isRecord(data) || !isRecord(data.view) || !isRecord(data.view.recording)) return undefined;
    return typeof data.view.recording.status === 'string' ? data.view.recording.status : undefined;
  }
}
