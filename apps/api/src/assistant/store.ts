import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { setTimeout as delay } from 'node:timers/promises';
import { isDynamoTransactionConflict } from '../../../../packages/dynamodb/src/conflict-retry.js';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import { validSession, validSessionRelations } from '../start-session/validation.js';
import type { SessionRecord } from '../start-session/types.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../../../packages/contracts/schemas/public.schema.json';
import { ActionError } from '../shared/action.js';
export class AssistantError extends Error {
  constructor(
    readonly code:
      'TURN_IN_PROGRESS' | 'TURN_INTERRUPTED' | 'ASSISTANT_UNAVAILABLE' | 'LIMIT_EXCEEDED' | 'SESSION_ACTIVE',
  ) {
    super(code);
  }
}
export interface SavedTurn {
  schemaVersion: 1;
  ownerId: string;
  requestHash: string;
  workerToken: string;
  createdAt: string;
  userText: string;
  view: PublicTypes['Turn'];
}
interface Conversation {
  activeId: string | null;
  expiresAt: string | null;
  count: number;
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const validTurn = ajv.getSchema<PublicTypes['Turn']>(schema.$id + '#/$defs/Turn')!;
const key = (id: string, SK: string) => ({ PK: 'SESSION#' + id, SK });
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function retryableWrite(error: unknown): boolean {
  if (isDynamoTransactionConflict(error)) return true;
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (
    Array.isArray(reasons) &&
    reasons.some((reason) => reason.Code === 'ConditionalCheckFailed') &&
    reasons.every(
      (reason) =>
        reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict',
    )
  );
}
export class AssistantStore {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly table: string,
    readonly now = Date.now,
  ) {}
  async get(id: string, SK: string, signal: AbortSignal): Promise<unknown> {
    return (
      await this.client.send(new GetCommand({ TableName: this.table, Key: key(id, SK), ConsistentRead: true }), {
        abortSignal: signal,
      })
    ).Item?.data;
  }
  async owned(id: string, owner: string, signal: AbortSignal): Promise<SessionRecord> {
    const session = await this.get(id, 'STATE', signal);
    if (!record(session) || session.ownerId !== owner) throw new ActionError('NOT_FOUND');
    if (!validSession(session) || !validSessionRelations(session) || session.view.id !== id)
      throw new Error('Invalid assistant session.');
    return session;
  }
  private saved(value: unknown, id: string, owner: string): SavedTurn | undefined {
    if (value === undefined) return undefined;
    if (
      !record(value) ||
      Object.keys(value).length !== 7 ||
      value.schemaVersion !== 1 ||
      value.ownerId !== owner ||
      !record(value.view) ||
      !validTurn(value.view) ||
      value.view.id !== id ||
      typeof value.view.status !== 'string' ||
      !['running', 'completed', 'failed', 'interrupted'].includes(value.view.status) ||
      typeof value.view.text !== 'string' ||
      value.view.text.length > 20000 ||
      !Array.isArray(value.view.proposals) ||
      value.view.proposals.length !== 0 ||
      typeof value.view.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.view.expiresAt)) ||
      typeof value.userText !== 'string' ||
      value.userText.length > 4000 ||
      typeof value.requestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.requestHash) ||
      typeof value.workerToken !== 'string'
    )
      throw new Error('Invalid saved turn.');
    if (
      typeof value.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      value.view.expiresAt !== new Date(Date.parse(value.createdAt) + 60000).toISOString() ||
      !value.userText.trim()
    )
      throw new Error('Invalid saved turn deadline.');
    return value as unknown as SavedTurn;
  }
  private slot(value: unknown): Conversation | undefined {
    if (value === undefined) return undefined;
    if (
      !record(value) ||
      Object.keys(value).length !== 3 ||
      typeof value.count !== 'number' ||
      !Number.isSafeInteger(value.count) ||
      value.count < 1 ||
      value.count > 50 ||
      (value.activeId !== null && typeof value.activeId !== 'string') ||
      (value.expiresAt !== null &&
        (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) ||
      (value.activeId === null) !== (value.expiresAt === null)
    )
      throw new Error('Invalid conversation.');
    return value as unknown as Conversation;
  }
  private unchanged(id: string, SK: string, before: unknown) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: key(id, SK),
        ConditionExpression: before === undefined ? 'attribute_not_exists(PK)' : '#d = :before',
        ...(before === undefined
          ? {}
          : { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':before': before } }),
      },
    };
  }
  private write(id: string, SK: string, data: unknown, before: unknown, work?: SavedTurn) {
    return {
      Put: {
        TableName: this.table,
        Item: {
          ...key(id, SK),
          data,
          ...(work ? { WorkPK: 'ASSISTANT', WorkSK: work.view.expiresAt + '#' + id + '#' + work.view.id } : {}),
        },
        ConditionExpression: before === undefined ? 'attribute_not_exists(PK)' : '#d = :before',
        ...(before === undefined
          ? {}
          : { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':before': before } }),
      },
    };
  }
  async expire(id: string, owner: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const slot = this.slot(await this.get(id, 'CONVERSATION', signal));
      if (!slot?.activeId || Date.parse(slot.expiresAt!) > this.now()) return;
      const turn = this.saved(await this.get(id, 'TURN#' + slot.activeId, signal), slot.activeId, owner);
      // The slot and turn are separate reads. Completion may race between them.
      if (!turn || turn.view.status !== 'running') {
        const latest = this.slot(await this.get(id, 'CONVERSATION', signal));
        if (latest?.activeId !== slot.activeId) continue;
        throw new Error('Invalid active turn.');
      }
      if (turn.view.expiresAt !== slot.expiresAt) throw new Error('Invalid active turn deadline.');
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              this.write(
                id,
                'TURN#' + turn.view.id,
                { ...turn, view: { ...turn.view, status: 'interrupted', text: '', proposals: [] } },
                turn,
              ),
              this.write(id, 'CONVERSATION', { ...slot, activeId: null, expiresAt: null }, slot),
            ],
          }),
          { abortSignal: signal },
        );
        return;
      } catch (error) {
        if (!retryableWrite(error)) throw error;
        await delay(25 * 2 ** attempt, undefined, { signal });
      }
    }
    throw new ActionError('CONFLICT');
  }
  async read(id: string, turnId: string, owner: string, signal: AbortSignal) {
    await this.owned(id, owner, signal);
    await this.expire(id, owner, signal);
    const turn = this.saved(await this.get(id, 'TURN#' + turnId, signal), turnId, owner);
    if (!turn) throw new ActionError('NOT_FOUND');
    return turn;
  }
  async admit(
    id: string,
    turnId: string,
    text: string,
    owner: string,
    signal: AbortSignal,
    allowFresh = true,
  ): Promise<{ saved: SavedTurn; session: SessionRecord; fresh: boolean }> {
    const requestHash = createHash('sha256').update(canonicalJson({ id, text })).digest('hex');
    for (let attempt = 0; attempt < 4; attempt++) {
      const session = await this.owned(id, owner, signal);
      await this.expire(id, owner, signal);
      const existing = this.saved(await this.get(id, 'TURN#' + turnId, signal), turnId, owner);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ActionError('IDEMPOTENCY_CONFLICT');
        return { saved: existing, session, fresh: false };
      }
      if (
        !allowFresh ||
        session.view.status !== 'ready' ||
        !session.view.endsAt ||
        Date.parse(session.view.endsAt) <= this.now()
      )
        throw new AssistantError('ASSISTANT_UNAVAILABLE');
      const slot = this.slot(await this.get(id, 'CONVERSATION', signal));
      if (slot?.activeId) throw new AssistantError('TURN_IN_PROGRESS');
      if ((slot?.count ?? 0) >= 50) throw new AssistantError('LIMIT_EXCEEDED');
      const createdAt = new Date(this.now()).toISOString(),
        expiresAt = new Date(this.now() + 60000).toISOString();
      const saved: SavedTurn = {
        schemaVersion: 1,
        ownerId: owner,
        requestHash,
        workerToken: randomUUID(),
        createdAt,
        userText: text,
        view: { id: turnId, status: 'running', text: '', proposals: [], expiresAt },
      };
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              this.write(id, 'TURN#' + turnId, saved, undefined, saved),
              this.write(id, 'CONVERSATION', { activeId: turnId, expiresAt, count: (slot?.count ?? 0) + 1 }, slot),
              this.write(
                id,
                'STATE',
                {
                  ...session,
                  view: {
                    ...session.view,
                    assistance: {
                      ...session.view.assistance,
                      assistantTurns: session.view.assistance.assistantTurns + 1,
                    },
                  },
                },
                session,
              ),
            ],
          }),
          { abortSignal: signal },
        );
        return { saved, session, fresh: true };
      } catch (error) {
        const receipt = await this.get(id, 'TURN#' + turnId, signal);
        if (receipt) continue;
        if (!retryableWrite(error)) throw error;
        await delay(25 * 2 ** attempt, undefined, { signal });
      }
    }
    throw new ActionError('CONFLICT');
  }
  async finish(
    id: string,
    turn: SavedTurn,
    text: string,
    status: 'completed' | 'failed',
    signal: AbortSignal,
  ): Promise<PublicTypes['Turn']> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const session = await this.owned(id, turn.ownerId, signal);
      await this.expire(id, turn.ownerId, signal);
      const current = this.saved(await this.get(id, 'TURN#' + turn.view.id, signal), turn.view.id, turn.ownerId),
        slot = this.slot(await this.get(id, 'CONVERSATION', signal));
      if (
        !current ||
        current.view.status !== 'running' ||
        current.workerToken !== turn.workerToken ||
        slot?.activeId !== turn.view.id ||
        Date.parse(current.view.expiresAt) <= this.now()
      )
        throw new AssistantError('TURN_INTERRUPTED');
      if (text.length > 20000) throw new Error('Assistant result exceeds its bound.');
      if (session.view.status !== 'ready' || !session.view.endsAt || Date.parse(session.view.endsAt) <= this.now())
        throw new AssistantError('TURN_INTERRUPTED');
      const view: PublicTypes['Turn'] = {
        ...current.view,
        status,
        text: status === 'completed' ? text : '',
        proposals: [],
      };
      try {
        await this.client.send(
          new TransactWriteCommand({
            ClientRequestToken: randomUUID(),
            TransactItems: [
              this.unchanged(id, 'STATE', session),
              this.write(id, 'TURN#' + turn.view.id, { ...current, view }, current),
              this.write(id, 'CONVERSATION', { ...slot, activeId: null, expiresAt: null }, slot),
            ],
          }),
          { abortSignal: signal },
        );
        return view;
      } catch (error) {
        const saved = this.saved(await this.get(id, 'TURN#' + turn.view.id, signal), turn.view.id, turn.ownerId);
        if (saved?.view.status === status) return saved.view;
        if (!retryableWrite(error)) throw error;
        await delay(25 * 2 ** attempt, undefined, { signal });
      }
    }
    throw new AssistantError('TURN_INTERRUPTED');
  }
  async history(id: string, owner: string, exclude: string, signal: AbortSignal) {
    const items: Record<string, unknown>[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const rows = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          ConsistentRead: true,
          Limit: 50 - items.length,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': 'SESSION#' + id, ':prefix': 'TURN#' },
        }),
        { abortSignal: signal },
      );
      items.push(...(rows.Items ?? []));
      cursor = rows.LastEvaluatedKey;
    } while (cursor && items.length < 50);
    const turns = items
      .map((row) => {
        if (typeof row.SK !== 'string') throw new Error('Invalid turn key.');
        return this.saved(row.data, row.SK.slice(5), owner)!;
      })
      .filter((turn) => turn.view.id !== exclude && turn.view.status === 'completed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return turns
      .slice(-4)
      .map((turn) => ({ user: turn.userText.slice(0, 2000), assistant: turn.view.text.slice(0, 3000) }));
  }
}
