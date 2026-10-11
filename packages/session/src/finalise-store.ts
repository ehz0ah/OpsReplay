import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { lifecycleKey, isSessionLifecycleState } from '../../contracts/private/session-lifecycle.js';
import { isMonitorRecordingState } from '../../contracts/private/monitor-persistence.js';
import { isDebrief, type Debrief } from './debrief.js';
import type { SessionRecord } from '../../../apps/api/src/start-session/types.js';
import { validSession, validProgress, validLock } from '../../../apps/api/src/start-session/validation.js';
import { isTerminalSessionId } from '../../contracts/private/terminal-access.js';

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export class FinaliseStoreError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_store' | 'pending' | 'conflict') {
    super('Session finalisation failed.');
    this.name = 'FinaliseStoreError';
  }
}
/** Once-only transaction. Progress must be visible before a new attempt can be
 * admitted, so the matching active lock is released in this same transaction. */
export class DynamoFinaliseStore {
  constructor(
    private readonly dynamo: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}
  private async get(key: { PK: string; SK: string }, signal?: AbortSignal) {
    return (
      await this.dynamo.send(
        new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }),
        signal ? { abortSignal: signal } : undefined,
      )
    ).Item?.data as unknown;
  }
  async saved(sessionId: string, signal?: AbortSignal): Promise<Debrief | undefined> {
    if (!isTerminalSessionId(sessionId)) throw new FinaliseStoreError('invalid_input');
    const data = await this.get({ PK: `SESSION#${sessionId}`, SK: 'DEBRIEF' }, signal);
    if (data === undefined) return undefined;
    if (!isDebrief(data) || data.sessionId !== sessionId) throw new FinaliseStoreError('invalid_store');
    return structuredClone(data);
  }
  async commit(session: SessionRecord, debrief: Debrief, signal?: AbortSignal): Promise<Debrief> {
    if (
      !validSession(session) ||
      !isDebrief(debrief) ||
      debrief.sessionId !== session.view.id ||
      session.view.readyAt === null ||
      debrief.outcome !== session.view.status ||
      !same(debrief.challenge, session.view.challenge) ||
      !same(debrief.attempt, session.view.attempt) ||
      !same(debrief.assistance, session.view.assistance) ||
      !same(debrief.recording, session.view.recording) ||
      !['complete', 'incomplete'].includes(session.view.recording.status)
    )
      throw new FinaliseStoreError('invalid_input');
    session = structuredClone(session);
    debrief = structuredClone(debrief);
    const id = session.view.id;
    const already = await this.saved(id, signal);
    if (already) return already;
    const stateKey = { PK: `SESSION#${id}`, SK: 'STATE' };
    const recordingKey = { PK: `SESSION#${id}`, SK: 'RECORDING' };
    const progressKey = { PK: `USER#${session.ownerId}`, SK: `PROGRESS#${session.view.challenge.id}` };
    const activeKey = { PK: `USER#${session.ownerId}`, SK: 'ACTIVE' };
    const [lifecycle, recording, progress, lock] = await Promise.all([
      this.get(lifecycleKey(id), signal),
      this.get(recordingKey, signal),
      this.get(progressKey, signal),
      this.get(activeKey, signal),
    ]);
    if (
      !isSessionLifecycleState(lifecycle, id) ||
      !lifecycle.taskStoppedAt ||
      !lifecycle.schedulesDeleted ||
      !isMonitorRecordingState(recording, id) ||
      !['complete', 'incomplete'].includes(recording.status) ||
      recording.status !== session.view.recording.status ||
      recording.reason !== session.view.recording.reason ||
      lifecycle.readyAt !== session.view.readyAt ||
      lifecycle.taskStoppedAt < session.view.endedAt! ||
      recording.cutoffAt !== session.view.endedAt
    )
      throw new FinaliseStoreError('pending');
    if ((progress !== undefined && !validProgress(progress)) || (lock !== undefined && !validLock(lock)))
      throw new FinaliseStoreError('invalid_store');
    const count = progress === undefined ? 0 : progress.completedAttempts;
    if (session.view.attempt.number !== count + 1 || (session.view.status !== 'error' && count >= 1000))
      throw new FinaliseStoreError('conflict');
    const updatedSession = { ...session, view: { ...session.view, debriefAvailable: true } };
    const unchanged = (Key: { PK: string; SK: string }, data: unknown) => ({
      ConditionCheck: {
        TableName: this.table,
        Key,
        ...(data === undefined
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#d = :expected',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':expected': data },
            }),
      },
    });
    const change = (Key: { PK: string; SK: string }, data: unknown, previous: unknown) => ({
      Put: {
        TableName: this.table,
        Item: { ...Key, data },
        ...(previous === undefined
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#d = :expected',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':expected': previous },
            }),
      },
    });
    const recorded = { PK: `SESSION#${id}`, SK: 'FINALISED' };
    const commands = [
      change(recorded, { schemaVersion: 1, sessionId: id, endedAt: session.view.endedAt }, undefined),
      change({ PK: `SESSION#${id}`, SK: 'DEBRIEF' }, debrief, undefined),
      {
        Put: {
          TableName: this.table,
          Item: { ...stateKey, data: updatedSession },
          ConditionExpression: '#d = :expected',
          ExpressionAttributeNames: { '#d': 'data' },
          ExpressionAttributeValues: { ':expected': session },
        },
      },
      unchanged(recordingKey, recording),
      {
        Put: {
          TableName: this.table,
          Item: { ...lifecycleKey(id), data: lifecycle },
          ConditionExpression: '#d = :expected',
          ExpressionAttributeNames: { '#d': 'data' },
          ExpressionAttributeValues: { ':expected': lifecycle },
        },
      },
      ...(session.view.status === 'error'
        ? [unchanged(progressKey, progress)]
        : [change(progressKey, { completedAttempts: count + 1 }, progress)]),
      ...(lock !== undefined && lock.sessionId === id
        ? [
            {
              Delete: {
                TableName: this.table,
                Key: activeKey,
                ConditionExpression: '#d = :expected',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':expected': lock },
              },
            },
          ]
        : [unchanged(activeKey, lock)]),
    ];
    try {
      await this.dynamo.send(
        new TransactWriteCommand({ ClientRequestToken: randomUUID(), TransactItems: commands }),
        signal ? { abortSignal: signal } : undefined,
      );
      return structuredClone(debrief);
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.saved(id, signal);
      if (saved) return saved;
      if (
        error instanceof Error &&
        ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name)
      )
        throw new FinaliseStoreError('conflict');
      throw error;
    }
  }
}
