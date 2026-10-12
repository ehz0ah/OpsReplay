import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  monitorObservationKey,
  isMonitorLifecycleObservation,
} from '../../../../packages/contracts/private/monitor-persistence.js';
import { isSessionLifecycleState, lifecycleKey } from '../../../../packages/contracts/private/session-lifecycle.js';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import { hintAvailableAt } from '../../../../packages/session/src/hints.js';
import { readManifest } from '../../../../packages/session/src/manifest.js';
import type { SessionRecord, SessionView } from '../start-session/types.js';
import { validHint, validOwner, validSession, validSessionRelations, validUuid } from '../start-session/validation.js';

export type HintReleaseErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SESSION_NOT_READY'
  | 'SESSION_TERMINAL'
  | 'HINT_NOT_AVAILABLE'
  | 'NO_HINTS_REMAINING'
  | 'INTERNAL_ERROR';

export class HintReleaseError extends Error {
  constructor(
    readonly code: HintReleaseErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super('Hint release failed.');
    this.name = 'HintReleaseError';
  }
}

type ReleasedHint = SessionView['hints']['released'][number];
interface HintReceipt {
  schemaVersion: 1;
  operation: 'release_hint';
  ownerId: string;
  requestId: string;
  sessionId: string;
  response: { hint: ReleasedHint; remaining: number };
}
export interface HintReleaseResult {
  hint: ReleasedHint;
  remaining: number;
  replayed: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const conditional = (error: unknown) =>
  error instanceof Error &&
  ['TransactionCanceledException', 'ConditionalCheckFailedException', 'TransactionConflictException'].includes(
    error.name,
  );
const options = (signal?: AbortSignal) => (signal ? { abortSignal: signal } : undefined);
const key = (id: string, SK: string) => ({ PK: `SESSION#${id}`, SK });

function isHintReceipt(value: unknown, id: string, ownerId: string, requestId: string): value is HintReceipt {
  if (!record(value) || !record(value.response)) return false;
  return (
    Object.keys(value).length === 6 &&
    value.schemaVersion === 1 &&
    value.operation === 'release_hint' &&
    value.ownerId === ownerId &&
    value.requestId === requestId &&
    value.sessionId === id &&
    Object.keys(value.response).length === 2 &&
    validHint(value.response.hint) &&
    Number.isInteger(value.response.remaining) &&
    (value.response.remaining as number) >= 0 &&
    (value.response.remaining as number) <= 20
  );
}

export class DynamoHintStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new HintReleaseError('INTERNAL_ERROR');
  }

  private async get(Key: { PK: string; SK: string }, signal?: AbortSignal): Promise<unknown> {
    return (
      await this.client.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }), options(signal))
    ).Item?.data;
  }

  private async receipt(
    id: string,
    ownerId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<HintReceipt | undefined> {
    const value = await this.get(key(id, `REQUEST#${requestId}`), signal);
    if (value === undefined) return undefined;
    if (record(value) && typeof value.ownerId === 'string' && value.ownerId !== ownerId)
      throw new HintReleaseError('NOT_FOUND');
    if (
      record(value) &&
      value.ownerId === ownerId &&
      value.requestId === requestId &&
      value.sessionId === id &&
      value.operation !== 'release_hint'
    )
      throw new HintReleaseError('IDEMPOTENCY_CONFLICT');
    if (!isHintReceipt(value, id, ownerId, requestId)) throw new HintReleaseError('INTERNAL_ERROR');
    return structuredClone(value);
  }

  private async owned(id: string, ownerId: string, signal?: AbortSignal): Promise<SessionRecord> {
    const value = await this.get(key(id, 'STATE'), signal);
    if (value === undefined || (record(value) && typeof value.ownerId === 'string' && value.ownerId !== ownerId))
      throw new HintReleaseError('NOT_FOUND');
    if (!validSession(value) || !validSessionRelations(value) || value.ownerId !== ownerId || value.view.id !== id)
      throw new HintReleaseError('INTERNAL_ERROR');
    return structuredClone(value);
  }

  private unchanged(Key: { PK: string; SK: string }, expected: unknown) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key,
        ConditionExpression: '#data = :expected',
        ExpressionAttributeNames: { '#data': 'data' },
        ExpressionAttributeValues: { ':expected': expected },
      },
    };
  }

  private async replay(id: string, ownerId: string, requestId: string, signal?: AbortSignal) {
    const receipt = await this.receipt(id, ownerId, requestId, signal);
    return receipt ? { ...structuredClone(receipt.response), replayed: true } : undefined;
  }

  async release(
    id: string,
    ownerId: string,
    requestId: string,
    at: string,
    signal?: AbortSignal,
  ): Promise<HintReleaseResult> {
    if (!validUuid(id) || !validOwner(ownerId) || !validUuid(requestId) || !Number.isFinite(Date.parse(at)))
      throw new HintReleaseError('INVALID_REQUEST');
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const replay = await this.replay(id, ownerId, requestId, signal);
      if (replay) return replay;

      const session = await this.owned(id, ownerId, signal);
      if (session.view.status === 'provisioning') throw new HintReleaseError('SESSION_NOT_READY');
      if (session.view.status !== 'ready' || !session.view.readyAt || !session.view.endsAt || at >= session.view.endsAt)
        throw new HintReleaseError('SESSION_TERMINAL');
      const index = session.view.hints.released.length;
      const plan = session.hintPlan[index];
      if (!plan) throw new HintReleaseError('NO_HINTS_REMAINING');
      const availableAt = hintAvailableAt(session.view.readyAt, plan.minElapsedMinutes);
      if (at < availableAt)
        throw new HintReleaseError(
          'HINT_NOT_AVAILABLE',
          Math.max(1, Math.ceil((Date.parse(availableAt) - Date.parse(at)) / 1000)),
        );

      const [lifecycle, observation, manifest] = await Promise.all([
        this.get(lifecycleKey(id), signal),
        this.get(monitorObservationKey(id), signal),
        readManifest(this.client, this.table, session, signal),
      ]);
      if (
        !isSessionLifecycleState(lifecycle, id) ||
        lifecycle.readyAt !== session.view.readyAt ||
        !isMonitorLifecycleObservation(observation, id) ||
        observation.startedAt !== session.view.readyAt ||
        canonicalJson(session.hintPlan) !==
          canonicalJson(manifest.hints.map(({ id: hintId, minElapsedMinutes }) => ({ id: hintId, minElapsedMinutes })))
      )
        throw new HintReleaseError('INTERNAL_ERROR');
      if (lifecycle.recovery?.state === 'met' || observation.recovery.state === 'met')
        throw new HintReleaseError('SESSION_TERMINAL');
      const authored = manifest.hints[index];
      if (!authored || authored.id !== plan.id) throw new HintReleaseError('INTERNAL_ERROR');

      const hint: ReleasedHint = { id: authored.id, text: authored.text, releasedAt: at };
      const remaining = session.hintPlan.length - index - 1;
      const following = session.hintPlan[index + 1];
      const hints = {
        released: [...session.view.hints.released, hint],
        remaining,
        nextAvailableAt: following ? hintAvailableAt(session.view.readyAt, following.minElapsedMinutes) : null,
      };
      const receipt: HintReceipt = {
        schemaVersion: 1,
        operation: 'release_hint',
        ownerId,
        requestId,
        sessionId: id,
        response: { hint, remaining },
      };
      const event = {
        id: `hint:${requestId}`,
        at,
        kind: 'assistance',
        action: 'hint_released',
        refId: hint.id,
      };
      const millis = String(Date.parse(at)).padStart(13, '0');
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              {
                Put: {
                  TableName: this.table,
                  Item: { ...key(id, `HINT#${hint.id}`), data: hint },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { ...key(id, `EVENT#${millis}#hint#${requestId}`), data: event },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Put: {
                  TableName: this.table,
                  Item: { ...key(id, `REQUEST#${requestId}`), data: receipt },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
              {
                Update: {
                  TableName: this.table,
                  Key: key(id, 'STATE'),
                  UpdateExpression:
                    'SET #data.#view.#hints = :hints, #data.#view.#assistance.#hintsReleased = :released',
                  ConditionExpression: '#data = :expected',
                  ExpressionAttributeNames: {
                    '#data': 'data',
                    '#view': 'view',
                    '#hints': 'hints',
                    '#assistance': 'assistance',
                    '#hintsReleased': 'hintsReleased',
                  },
                  ExpressionAttributeValues: {
                    ':expected': session,
                    ':hints': hints,
                    ':released': index + 1,
                  },
                },
              },
              this.unchanged(lifecycleKey(id), lifecycle),
              this.unchanged(monitorObservationKey(id), observation),
            ],
          }),
          options(signal),
        );
        return { hint: structuredClone(hint), remaining, replayed: false };
      } catch (error) {
        if (signal?.aborted) throw error;
        const committed = await this.replay(id, ownerId, requestId, signal);
        if (committed) return committed;
        if (!conditional(error) || attempt === 2) throw error;
      }
    }
    throw new HintReleaseError('INTERNAL_ERROR');
  }
}
