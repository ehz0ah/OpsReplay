import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../contracts/schemas/public.schema.json';
import {
  isMonitorRecordingState,
  isMonitorLifecycleObservation,
  monitorObservationKey,
  type MonitorLifecycleObservation,
  type MonitorRecordingState,
} from '../../contracts/private/monitor-persistence.js';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  drainDeadlineAt,
  initialSessionLifecycle,
  isLifecycleRecovery,
  isSessionLifecycleState,
  lifecycleKey,
  lifecycleWorkItem,
  sessionLifecycle,
  type LifecycleRecovery,
  type SessionLifecycleState,
} from '../../contracts/private/session-lifecycle.js';
import {
  isTerminalInputRecord,
  isTerminalOwnerId,
  isTerminalSessionId,
  isTerminalTimestamp,
  type TerminalInputRecord,
} from '../../contracts/private/terminal-access.js';
import {
  isTerminalRecordingCheckpoint,
  type TerminalRecordingCheckpoint,
} from '../../contracts/private/terminal-persistence.js';
import { recordingRetainUntil } from '../../contracts/private/recording-retention.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const validView = ajv.compile({ $ref: `${publicSchema.$id}#/$defs/SessionView` });

export type SessionOutcome = 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
export type OutcomeReason =
  'validators_passed' | 'time_limit' | 'learner_ended' | 'heartbeat_missed' | 'environment_exited' | 'start_failed';
export interface AttemptView {
  id: string;
  status: 'provisioning' | 'ready' | SessionOutcome;
  statusReason: OutcomeReason | null;
  createdAt: string;
  readyAt: string | null;
  endsAt: string | null;
  endedAt: string | null;
  timeLimitSeconds: number;
  recording: { status: 'pending' | 'recording' | 'draining' | 'complete' | 'incomplete'; reason: string | null };
  recovery: LifecycleRecovery | null;
}
export interface AttemptSnapshot {
  ownerId: string;
  view: AttemptView;
  provisioningDeadline: string;
  taskArn: string | null;
  taskAddress: string | null;
}
export interface RecorderIdentity {
  sessionId: string;
  recorderId: string;
  generation: number;
}
export class AttemptStoreError extends Error {
  constructor(
    readonly code: 'invalid_config' | 'invalid_input' | 'invalid_store' | 'not_found' | 'stale_lease' | 'conflict',
  ) {
    super('Session lifecycle operation failed.');
    this.name = 'AttemptStoreError';
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const options = (signal?: AbortSignal) => (signal ? { abortSignal: signal } : undefined);
const stateKey = (id: string) => ({ PK: `SESSION#${id}`, SK: 'STATE' });
const recordingKey = (id: string) => ({ PK: `SESSION#${id}`, SK: 'RECORDING' });
const terminalKey = (id: string) => ({ PK: `SESSION#${id}`, SK: 'TERMINAL_RECORDING' });
const active = (status: AttemptView['status']) => status === 'provisioning' || status === 'ready';
const conditional = (error: unknown) =>
  error instanceof Error &&
  ['TransactionCanceledException', 'ConditionalCheckFailedException', 'TransactionConflictException'].includes(
    error.name,
  );
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a, (_key, value: unknown) =>
    record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
  ) ===
  JSON.stringify(b, (_key, value: unknown) =>
    record(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
  );

function snapshot(data: unknown, id: string): AttemptSnapshot {
  if (!record(data) || !isTerminalOwnerId(data.ownerId) || !record(data.view) || !validView(data.view))
    throw new AttemptStoreError('invalid_store');
  const view = data.view;
  if (
    view.id !== id ||
    !['provisioning', 'ready', 'resolved', 'failed', 'ended', 'abandoned', 'error'].includes(view.status as string) ||
    !isTerminalTimestamp(view.createdAt) ||
    !isTerminalTimestamp(data.provisioningDeadline) ||
    !Number.isInteger(view.timeLimitSeconds) ||
    (view.timeLimitSeconds as number) < 60 ||
    (view.timeLimitSeconds as number) > 14_400 ||
    !record(view.recording) ||
    !['pending', 'recording', 'draining', 'complete', 'incomplete'].includes(view.recording.status as string) ||
    (view.recording.reason !== null && typeof view.recording.reason !== 'string') ||
    (view.recovery !== null && !isLifecycleRecovery(view.recovery)) ||
    ![view.readyAt, view.endsAt, view.endedAt].every((value) => value === null || isTerminalTimestamp(value)) ||
    (data.taskArn !== null && typeof data.taskArn !== 'string') ||
    (data.taskAddress !== null && typeof data.taskAddress !== 'string')
  )
    throw new AttemptStoreError('invalid_store');
  const allowedReasons: Record<string, unknown> = {
    provisioning: null,
    ready: null,
    resolved: 'validators_passed',
    ended: 'learner_ended',
    abandoned: 'heartbeat_missed',
  };
  if (
    !record(data.accessGrant) ||
    !['free', 'pro'].includes(data.accessGrant.plan as string) ||
    data.accessGrant.admittedAt !== view.createdAt ||
    data.accessGrant.timeLimitSeconds !== view.timeLimitSeconds ||
    data.provisioningDeadline <= view.createdAt ||
    (data.taskAddress !== null &&
      (typeof data.taskAddress !== 'string' || isIP(data.taskAddress) !== 4 || data.taskArn === null)) ||
    (data.taskArn !== null &&
      !/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:task\/(?:[A-Za-z0-9_-]+\/)?[a-f0-9-]+$/.test(
        data.taskArn as string,
      )) ||
    (Object.hasOwn(allowedReasons, view.status as string) &&
      view.statusReason !== allowedReasons[view.status as string]) ||
    (view.status === 'failed' && !['time_limit', 'environment_exited'].includes(view.statusReason as string)) ||
    (view.status === 'error' && !['start_failed', 'environment_exited'].includes(view.statusReason as string)) ||
    (view.readyAt === null
      ? view.endsAt !== null
      : (view.readyAt as string) < view.createdAt ||
        view.endsAt !==
          new Date(Date.parse(view.readyAt as string) + (view.timeLimitSeconds as number) * 1000).toISOString()) ||
    (active(view.status as AttemptView['status'])
      ? view.endedAt !== null
      : view.endedAt === null || (view.endedAt as string) < ((view.readyAt ?? view.createdAt) as string)) ||
    (view.status === 'ready' && (view.readyAt === null || view.endsAt === null || view.endedAt !== null)) ||
    (view.status === 'provisioning' && view.readyAt !== null) ||
    (['resolved', 'failed', 'abandoned'].includes(view.status as string) && view.readyAt === null)
  )
    throw new AttemptStoreError('invalid_store');
  return structuredClone(data) as unknown as AttemptSnapshot;
}

/** Shared in-process adapter. No Lambda invocation and no monitor network access. */
export class DynamoAttemptStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new AttemptStoreError('invalid_config');
  }
  private validate(id: string, now?: string) {
    if (!isTerminalSessionId(id) || (now !== undefined && !isTerminalTimestamp(now)))
      throw new AttemptStoreError('invalid_input');
  }
  private async data(key: { PK: string; SK: string }, signal?: AbortSignal): Promise<unknown> {
    return (
      await this.client.send(new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }), options(signal))
    ).Item?.data;
  }
  async session(id: string, signal?: AbortSignal): Promise<AttemptSnapshot | undefined> {
    this.validate(id);
    const value = await this.data(stateKey(id), signal);
    return value === undefined ? undefined : snapshot(value, id);
  }
  async lifecycle(id: string, signal?: AbortSignal): Promise<SessionLifecycleState | undefined> {
    this.validate(id);
    const value = await this.data(lifecycleKey(id), signal);
    if (value === undefined) return undefined;
    if (!isSessionLifecycleState(value, id)) throw new AttemptStoreError('invalid_store');
    return structuredClone(value);
  }
  async recording(id: string, signal?: AbortSignal): Promise<MonitorRecordingState | undefined> {
    this.validate(id);
    const value = await this.data(recordingKey(id), signal);
    if (value === undefined) return undefined;
    if (!isMonitorRecordingState(value, id)) throw new AttemptStoreError('invalid_store');
    return structuredClone(value);
  }
  async observation(id: string, signal?: AbortSignal): Promise<MonitorLifecycleObservation | undefined> {
    this.validate(id);
    const value = await this.data(monitorObservationKey(id), signal);
    if (value === undefined) return undefined;
    if (!isMonitorLifecycleObservation(value, id)) throw new AttemptStoreError('invalid_store');
    return structuredClone(value);
  }
  private condition(key: { PK: string; SK: string }, expected: unknown) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: key,
        ...(expected === undefined
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#data = :expected',
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':expected': expected },
            }),
      },
    };
  }
  private lifecyclePut(previous: SessionLifecycleState | undefined, next: SessionLifecycleState) {
    if (!isSessionLifecycleState(next, next.sessionId)) throw new AttemptStoreError('invalid_store');
    return {
      Put: {
        TableName: this.table,
        Item: lifecycleWorkItem(next),
        ...(previous === undefined
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#data = :expected',
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':expected': previous },
            }),
      },
    };
  }
  async ready(
    identity: RecorderIdentity,
    startedAt: string,
    terminal: TerminalRecordingCheckpoint,
    recovery: LifecycleRecovery,
    now: string,
    signal?: AbortSignal,
  ): Promise<AttemptSnapshot> {
    this.validate(identity.sessionId, now);
    terminal = structuredClone(terminal);
    recovery = structuredClone(recovery);
    if (
      !isTerminalTimestamp(startedAt) ||
      startedAt > now ||
      !isTerminalRecordingCheckpoint(terminal) ||
      terminal.cursor < 1 ||
      terminal.metadata.loss !== null ||
      terminal.metadata.shellState !== 'running' ||
      terminal.metadata.startedAt > startedAt ||
      !isLifecycleRecovery(recovery) ||
      recovery.state !== 'failing'
    )
      throw new AttemptStoreError('invalid_input');
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await this.session(identity.sessionId, signal);
      if (!session) throw new AttemptStoreError('not_found');
      if (session.view.status !== 'provisioning') return session;
      if (
        startedAt < session.view.createdAt ||
        now >= session.provisioningDeadline ||
        Date.parse(now) >= Date.parse(startedAt) + session.view.timeLimitSeconds * 1000 ||
        !session.taskArn ||
        !session.taskAddress ||
        session.view.recording.status !== 'recording'
      )
        throw new AttemptStoreError('conflict');
      const previous = await this.lifecycle(identity.sessionId, signal);
      const initial = previous ?? initialSessionLifecycle(identity.sessionId, session.view.createdAt);
      const next = {
        ...initial,
        readyAt: startedAt,
        terminalSource: terminal.metadata.source,
        lastSeenAt: startedAt,
        lastMonitorAt: now,
        recovery,
      };
      const recording = await this.recording(identity.sessionId, signal);
      if (
        !recording ||
        recording.status !== 'recording' ||
        recording.startedAt !== startedAt ||
        recording.recorderId !== identity.recorderId ||
        recording.generation !== identity.generation ||
        recording.leaseExpiresAt! <= now
      )
        throw new AttemptStoreError('stale_lease');
      const observation = await this.observation(identity.sessionId, signal);
      if (
        !observation ||
        observation.startedAt !== startedAt ||
        observation.source !== recording.source ||
        observation.cursor > recording.cursor ||
        !same(observation.recovery, recovery) ||
        observation.at > now
      )
        throw new AttemptStoreError('invalid_store');
      next.lastMonitorAt = observation.at;
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              this.condition(recordingKey(identity.sessionId), recording),
              this.condition(monitorObservationKey(identity.sessionId), observation),
              this.condition(terminalKey(identity.sessionId), terminal),
              this.lifecyclePut(previous, next),
              {
                Update: {
                  TableName: this.table,
                  Key: stateKey(identity.sessionId),
                  UpdateExpression:
                    'SET #data.#view.#status = :ready, #data.#view.#readyAt = :startedAt, #data.#view.#endsAt = :endsAt, #data.#view.#recovery = :recovery',
                  ConditionExpression: '#data = :session',
                  ExpressionAttributeNames: {
                    '#data': 'data',
                    '#view': 'view',
                    '#status': 'status',
                    '#readyAt': 'readyAt',
                    '#endsAt': 'endsAt',
                    '#recovery': 'recovery',
                  },
                  ExpressionAttributeValues: {
                    ':session': session,
                    ':ready': 'ready',
                    ':startedAt': startedAt,
                    ':endsAt': new Date(Date.parse(startedAt) + session.view.timeLimitSeconds * 1000).toISOString(),
                    ':recovery': recovery,
                  },
                },
              },
            ],
          }),
          options(signal),
        );
        return (await this.session(identity.sessionId, signal))!;
      } catch (error) {
        if (signal?.aborted) throw error;
        const saved = await this.session(identity.sessionId, signal);
        if (saved && saved.view.readyAt === startedAt) return saved;
        if (!conditional(error) || attempt === 2) throw error;
      }
    }
    throw new AttemptStoreError('conflict');
  }
  async outcome(
    id: string,
    status: SessionOutcome,
    reason: OutcomeReason,
    cutoffAt: string,
    signal?: AbortSignal,
    ownerId?: string,
    recorder?: RecorderIdentity,
    observedAt: string = cutoffAt,
    requestId?: string,
    expectedLifecycle?: SessionLifecycleState,
  ): Promise<AttemptSnapshot> {
    this.validate(id, cutoffAt);
    if (
      !isTerminalTimestamp(observedAt) ||
      observedAt < cutoffAt ||
      (recorder !== undefined && recorder.sessionId !== id)
    )
      throw new AttemptStoreError('invalid_input');
    if (requestId !== undefined && (!isTerminalSessionId(requestId) || ownerId === undefined || status !== 'ended'))
      throw new AttemptStoreError('invalid_input');
    const valid = {
      resolved: ['validators_passed'],
      failed: ['time_limit', 'environment_exited'],
      ended: ['learner_ended'],
      abandoned: ['heartbeat_missed'],
      error: ['environment_exited', 'start_failed'],
    };
    if (!valid[status]?.includes(reason)) throw new AttemptStoreError('invalid_input');
    if (ownerId !== undefined && !isTerminalOwnerId(ownerId)) throw new AttemptStoreError('invalid_input');
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await this.session(id, signal);
      if (!session || (ownerId !== undefined && session.ownerId !== ownerId)) throw new AttemptStoreError('not_found');
      if (requestId !== undefined) {
        const receipt = await this.data({ PK: `SESSION#${id}`, SK: `REQUEST#${requestId}` }, signal);
        if (
          receipt !== undefined &&
          !same(receipt, { schemaVersion: 1, operation: 'end_session', ownerId, requestId, sessionId: id })
        )
          throw new AttemptStoreError('conflict');
      }
      if (!active(session.view.status)) {
        if (requestId !== undefined) await this.saveEndReceipt(id, ownerId!, requestId, session, signal);
        return session;
      }
      if (cutoffAt < (session.view.readyAt ?? session.view.createdAt)) throw new AttemptStoreError('invalid_input');
      const replayedRecovery =
        status === 'resolved' &&
        reason === 'validators_passed' &&
        expectedLifecycle?.recovery?.state === 'met' &&
        expectedLifecycle.lastMonitorAt === cutoffAt &&
        session.view.endsAt !== null &&
        cutoffAt < session.view.endsAt;
      if (
        session.view.status === 'ready' &&
        reason !== 'time_limit' &&
        session.view.endsAt !== null &&
        observedAt >= session.view.endsAt &&
        !replayedRecovery
      ) {
        cutoffAt = session.view.endsAt;
        status = 'failed';
        reason = 'time_limit';
      }
      if (
        (session.view.status === 'provisioning' && !['error', 'ended'].includes(status)) ||
        (reason === 'start_failed' && session.view.status !== 'provisioning')
      )
        throw new AttemptStoreError('conflict');
      const previous = await this.lifecycle(id, signal);
      if (expectedLifecycle !== undefined && !same(previous, expectedLifecycle)) return session;
      const initial = previous ?? initialSessionLifecycle(id, session.view.createdAt);
      if (
        reason === 'time_limit' &&
        (session.view.endsAt === null || cutoffAt !== session.view.endsAt || observedAt < session.view.endsAt)
      )
        throw new AttemptStoreError('conflict');
      if (
        reason === 'heartbeat_missed' &&
        (initial.lastSeenAt === null ||
          Date.parse(observedAt) - Date.parse(initial.lastSeenAt) < sessionLifecycle.heartbeatTimeoutMs)
      )
        throw new AttemptStoreError('conflict');
      if (
        reason === 'validators_passed' &&
        (initial.recovery?.state !== 'met' ||
          initial.lastMonitorAt !== cutoffAt ||
          (!recorder && expectedLifecycle === undefined) ||
          session.view.endsAt === null ||
          cutoffAt >= session.view.endsAt)
      )
        throw new AttemptStoreError('conflict');
      const recording = await this.recording(id, signal);
      if (
        (session.view.recording.status === 'pending' && recording !== undefined) ||
        (session.view.recording.status !== 'pending' && session.view.recording.status !== recording?.status)
      )
        throw new AttemptStoreError('conflict');
      if (recording?.startedAt !== null && recording?.startedAt !== undefined && cutoffAt < recording.startedAt)
        throw new AttemptStoreError('conflict');
      const draining = session.view.recording.status === 'recording' && recording?.startedAt !== null;
      const unstarted = session.view.recording.status === 'recording' && recording?.startedAt === null;
      if ((draining || unstarted) && (!recording || recording.status !== 'recording'))
        throw new AttemptStoreError('invalid_store');
      if (
        recorder &&
        (!record(recording) ||
          recording.recorderId !== recorder.recorderId ||
          recording.generation !== recorder.generation ||
          typeof recording.leaseExpiresAt !== 'string' ||
          recording.leaseExpiresAt <= observedAt)
      )
        throw new AttemptStoreError('stale_lease');
      const next = { ...initial, drainDeadlineAt: draining ? drainDeadlineAt(cutoffAt) : null };
      const nextRecording = draining
        ? { ...recording, status: 'draining', cutoffAt, drainDeadlineAt: next.drainDeadlineAt, updatedAt: observedAt }
        : unstarted
          ? {
              ...recording,
              status: 'incomplete',
              cutoffAt,
              drainDeadlineAt: drainDeadlineAt(cutoffAt),
              updatedAt: observedAt,
              completedAt: observedAt,
              recorderId: null,
              leaseExpiresAt: null,
              reason: 'recorder_lost',
              retainUntil: recordingRetainUntil(observedAt, 'provisional'),
            }
          : null;
      if (nextRecording && !isMonitorRecordingState(nextRecording, id)) throw new AttemptStoreError('invalid_store');
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              this.lifecyclePut(previous, next),
              ...(requestId !== undefined
                ? [
                    {
                      Put: {
                        TableName: this.table,
                        Item: {
                          PK: `SESSION#${id}`,
                          SK: `REQUEST#${requestId}`,
                          data: { schemaVersion: 1, operation: 'end_session', ownerId, requestId, sessionId: id },
                        },
                        ConditionExpression: 'attribute_not_exists(PK)',
                      },
                    },
                  ]
                : []),
              ...(nextRecording
                ? [
                    {
                      Put: {
                        TableName: this.table,
                        Item: { ...recordingKey(id), data: nextRecording },
                        ConditionExpression: '#data = :expected',
                        ExpressionAttributeNames: { '#data': 'data' },
                        ExpressionAttributeValues: { ':expected': recording },
                      },
                    },
                  ]
                : [this.condition(recordingKey(id), recording)]),
              {
                Update: {
                  TableName: this.table,
                  Key: stateKey(id),
                  UpdateExpression:
                    'SET #data.#view.#status = :status, #data.#view.#reason = :reason, #data.#view.#endedAt = :cutoff, #data.#view.#recording.#status = :recordingStatus, #data.#view.#recording.#recordingReason = :recordingReason',
                  ConditionExpression: '#data = :session',
                  ExpressionAttributeNames: {
                    '#data': 'data',
                    '#view': 'view',
                    '#status': 'status',
                    '#reason': 'statusReason',
                    '#endedAt': 'endedAt',
                    '#recording': 'recording',
                    '#recordingReason': 'reason',
                  },
                  ExpressionAttributeValues: {
                    ':session': session,
                    ':status': status,
                    ':reason': reason,
                    ':cutoff': cutoffAt,
                    ':recordingStatus': draining
                      ? 'draining'
                      : unstarted
                        ? 'incomplete'
                        : session.view.recording.status,
                    ':recordingReason': unstarted ? 'recorder_lost' : session.view.recording.reason,
                  },
                },
              },
            ],
          }),
          options(signal),
        );
        return (await this.session(id, signal))!;
      } catch (error) {
        if (signal?.aborted) throw error;
        const saved = await this.session(id, signal);
        if (saved && !active(saved.view.status)) {
          if (requestId !== undefined) await this.saveEndReceipt(id, ownerId!, requestId, saved, signal);
          return saved;
        }
        if (!conditional(error) || attempt === 2) throw error;
      }
    }
    throw new AttemptStoreError('conflict');
  }
  private async saveEndReceipt(
    id: string,
    ownerId: string,
    requestId: string,
    session: AttemptSnapshot,
    signal?: AbortSignal,
  ) {
    const key = { PK: `SESSION#${id}`, SK: `REQUEST#${requestId}` };
    const expected = { schemaVersion: 1, operation: 'end_session', ownerId, requestId, sessionId: id };
    const current = await this.data(key, signal);
    if (current !== undefined) {
      if (!same(current, expected)) throw new AttemptStoreError('conflict');
      return;
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.condition(stateKey(id), session),
            {
              Put: {
                TableName: this.table,
                Item: { ...key, data: expected },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
        options(signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      if (same(await this.data(key, signal), expected)) return;
      throw error;
    }
  }
  async heartbeat(
    input: Pick<TerminalInputRecord, 'sessionId' | 'connectionId' | 'generation'>,
    now: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.validate(input.sessionId, now);
    const owner = await this.data({ PK: `SESSION#${input.sessionId}`, SK: 'INPUT' }, signal);
    if (
      !isTerminalInputRecord(owner) ||
      owner.connectionId !== input.connectionId ||
      owner.generation !== input.generation
    )
      throw new AttemptStoreError('conflict');
    const previous = await this.lifecycle(input.sessionId, signal);
    if (!previous || previous.readyAt === null || previous.lastSeenAt === null)
      throw new AttemptStoreError('invalid_store');
    if (
      now <= previous.lastSeenAt ||
      Date.parse(now) - Date.parse(previous.lastSeenAt) < sessionLifecycle.heartbeatWriteIntervalMs
    )
      return;
    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.condition({ PK: `SESSION#${input.sessionId}`, SK: 'INPUT' }, owner),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: stateKey(input.sessionId),
                ConditionExpression: '#data.#view.#status = :ready',
                ExpressionAttributeNames: { '#data': 'data', '#view': 'view', '#status': 'status' },
                ExpressionAttributeValues: { ':ready': 'ready' },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: lifecycleKey(input.sessionId),
                UpdateExpression: 'SET #data.#lastSeenAt = :now',
                ConditionExpression: '#data.#lastSeenAt <= :now AND #data.#readyAt = :readyAt',
                ExpressionAttributeNames: { '#data': 'data', '#lastSeenAt': 'lastSeenAt', '#readyAt': 'readyAt' },
                ExpressionAttributeValues: { ':now': now, ':readyAt': previous.readyAt },
              },
            },
          ],
        }),
        options(signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const [saved, currentOwner, session] = await Promise.all([
        this.lifecycle(input.sessionId, signal),
        this.data({ PK: `SESSION#${input.sessionId}`, SK: 'INPUT' }, signal),
        this.session(input.sessionId, signal),
      ]);
      if (
        isTerminalInputRecord(currentOwner) &&
        currentOwner.connectionId === input.connectionId &&
        currentOwner.generation === input.generation &&
        session?.view.status === 'ready' &&
        saved?.lastSeenAt !== null &&
        saved?.lastSeenAt !== undefined &&
        saved.lastSeenAt >= now
      )
        return;
      if (conditional(error)) throw new AttemptStoreError('conflict');
      throw error;
    }
  }
  /** Apply only a metric observation committed with its monitor page. A sweep can replay this after worker loss. */
  async observe(id: string, now: string, signal?: AbortSignal, identity?: RecorderIdentity): Promise<void> {
    this.validate(id, now);
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await this.session(id, signal);
      if (!session || session.view.status !== 'ready') return;
      const previous = await this.lifecycle(id, signal);
      const observation = await this.observation(id, signal);
      const recording = await this.recording(id, signal);
      if (
        !previous ||
        previous.readyAt !== session.view.readyAt ||
        previous.lastMonitorAt === null ||
        !observation ||
        !recording ||
        recording.status !== 'recording' ||
        observation.source !== recording.source ||
        observation.cursor > recording.cursor ||
        observation.startedAt !== previous.readyAt ||
        observation.at > now ||
        observation.recovery.requiredSeconds !== previous.recovery?.requiredSeconds
      )
        throw new AttemptStoreError('invalid_store');
      if (
        identity &&
        (identity.sessionId !== id ||
          identity.recorderId !== recording.recorderId ||
          identity.generation !== recording.generation ||
          recording.leaseExpiresAt! <= now)
      )
        throw new AttemptStoreError('stale_lease');
      if (observation.at < previous.lastMonitorAt) return;
      if (session.view.endsAt === null) throw new AttemptStoreError('invalid_store');
      if (observation.at >= session.view.endsAt) {
        await this.outcome(id, 'failed', 'time_limit', session.view.endsAt, signal, undefined, identity, now);
        return;
      }
      const next = { ...previous, lastMonitorAt: observation.at, recovery: observation.recovery };
      if (!same(previous, next)) {
        try {
          await this.client.send(
            new TransactWriteCommand({
              ClientRequestToken: randomUUID(),
              TransactItems: [
                this.condition(recordingKey(id), recording),
                this.condition(monitorObservationKey(id), observation),
                this.lifecyclePut(previous, next),
                {
                  Update: {
                    TableName: this.table,
                    Key: stateKey(id),
                    UpdateExpression: 'SET #data.#view.#recovery = :recovery',
                    ConditionExpression: '#data = :session',
                    ExpressionAttributeNames: { '#data': 'data', '#view': 'view', '#recovery': 'recovery' },
                    ExpressionAttributeValues: { ':session': session, ':recovery': observation.recovery },
                  },
                },
              ],
            }),
            options(signal),
          );
        } catch (error) {
          if (signal?.aborted || !conditional(error) || attempt === 2) throw error;
          continue;
        }
      }
      if (observation.recovery.state === 'met')
        await this.outcome(
          id,
          'resolved',
          'validators_passed',
          observation.at,
          signal,
          undefined,
          undefined,
          now,
          undefined,
          next,
        );
      return;
    }
    throw new AttemptStoreError('conflict');
  }
  async incomplete(
    id: string,
    reason: 'task_lost' | 'recorder_lost' | 'drain_timeout' | 'limit_exceeded' | 'data_gap',
    now: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.validate(id, now);
    const session = await this.session(id, signal);
    if (!session || active(session.view.status) || !session.view.endedAt) throw new AttemptStoreError('conflict');
    const current = await this.recording(id, signal);
    if (!record(current)) throw new AttemptStoreError('invalid_store');
    if (current.status === 'complete' || current.status === 'incomplete') return;
    if (
      current.status !== 'draining' ||
      typeof current.drainDeadlineAt !== 'string' ||
      now < session.view.endedAt ||
      (reason === 'drain_timeout' && now < current.drainDeadlineAt)
    )
      throw new AttemptStoreError('conflict');
    const next = {
      ...current,
      status: 'incomplete',
      recorderId: null,
      leaseExpiresAt: null,
      sealed: null,
      reason,
      retainUntil: recordingRetainUntil(typeof current.startedAt === 'string' ? current.startedAt : now, 'provisional'),
      updatedAt: now,
      completedAt: now,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { ...recordingKey(id), data: next },
                ConditionExpression: '#data = :expected',
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: { ':expected': current },
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: stateKey(id),
                UpdateExpression:
                  'SET #data.#view.#recording.#status = :status, #data.#view.#recording.#reason = :reason',
                ConditionExpression: '#data = :session',
                ExpressionAttributeNames: {
                  '#data': 'data',
                  '#view': 'view',
                  '#recording': 'recording',
                  '#status': 'status',
                  '#reason': 'reason',
                },
                ExpressionAttributeValues: { ':session': session, ':status': 'incomplete', ':reason': reason },
              },
            },
          ],
        }),
        options(signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.data(recordingKey(id), signal);
      if (record(saved) && (saved.status === 'complete' || same(saved, next))) return;
      throw error;
    }
  }
  async completeNeverReady(id: string, now: string, signal?: AbortSignal): Promise<void> {
    this.validate(id, now);
    const session = await this.session(id, signal);
    const lifecycle = await this.lifecycle(id, signal);
    if (
      !session ||
      active(session.view.status) ||
      session.view.readyAt !== null ||
      !lifecycle?.schedulesDeleted ||
      lifecycle.taskStoppedAt === null
    )
      throw new AttemptStoreError('conflict');
    const item = (
      await this.client.send(
        new GetCommand({ TableName: this.table, Key: lifecycleKey(id), ConsistentRead: true }),
        options(signal),
      )
    ).Item;
    if (item?.WorkPK === undefined && item?.WorkSK === undefined) return;
    const key = { PK: `USER#${session.ownerId}`, SK: 'ACTIVE' };
    const lock = await this.data(key, signal);
    await this.client.send(
      new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          {
            Update: {
              TableName: this.table,
              Key: stateKey(id),
              UpdateExpression: 'REMOVE WorkPK, WorkSK',
              ConditionExpression: '#data = :expected',
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':expected': session },
            },
          },
          ...(record(lock) && lock.sessionId === id
            ? [
                {
                  Delete: {
                    TableName: this.table,
                    Key: key,
                    ConditionExpression: '#data = :expected',
                    ExpressionAttributeNames: { '#data': 'data' },
                    ExpressionAttributeValues: { ':expected': lock },
                  },
                },
              ]
            : []),
          {
            Update: {
              TableName: this.table,
              Key: lifecycleKey(id),
              UpdateExpression: 'REMOVE WorkPK, WorkSK',
              ConditionExpression: '#data = :expected',
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':expected': lifecycle },
            },
          },
        ],
      }),
      options(signal),
    );
  }
  async cleanup(id: string, now: string, schedulesDeleted: boolean, signal?: AbortSignal): Promise<void> {
    this.validate(id, now);
    const session = await this.session(id, signal);
    const previous = await this.lifecycle(id, signal);
    if (
      !session ||
      active(session.view.status) ||
      !previous ||
      (session.view.readyAt !== null && !['complete', 'incomplete'].includes(session.view.recording.status))
    )
      throw new AttemptStoreError('conflict');
    const next = {
      ...previous,
      taskStoppedAt: previous.taskStoppedAt ?? now,
      schedulesDeleted: previous.schedulesDeleted || schedulesDeleted,
    };
    if (same(previous, next)) return;
    await this.client.send(
      new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [this.condition(stateKey(id), session), this.lifecyclePut(previous, next)],
      }),
      options(signal),
    );
  }
}
