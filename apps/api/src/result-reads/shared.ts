import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../../packages/contracts/schemas/public.schema.json';
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const validAssistance = ajv.getSchema(`${publicSchema.$id}#/$defs/TimelineEvent/oneOf/2`)!;
import { validOwner, validUuid, validSession, validSessionRelations } from '../start-session/validation.js';
import type { SessionRecord } from '../start-session/types.js';
import { isDebrief, type Debrief } from '../../../../packages/session/src/debrief.js';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import { playbackLimits } from '../../../../packages/contracts/private/playback-persistence.js';

const errors = {
  INVALID_REQUEST: [400, 'Invalid session read request.'],
  INVALID_CURSOR: [400, 'Restart paging with a new cursor.'],
  UNAUTHENTICATED: [401, 'Sign in before reading a session.'],
  NOT_FOUND: [404, 'Session result not found.'],
  SESSION_ACTIVE: [409, 'The session is active.'],
  DEBRIEF_PENDING: [409, 'The session result is being prepared.'],
  PLAYBACK_PENDING: [409, 'The session playback is being prepared.'],
  RECORDING_EXPIRED: [410, 'The recording retention period has ended.'],
  INTERNAL_ERROR: [500, 'The session result could not be read. Try again.'],
} as const;
export class ResultReadError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(code);
  }
}
export class ResultReader {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error('Invalid result table.');
  }
  async get(id: string, SK: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return (
      await this.client.send(
        new GetCommand({ TableName: this.table, Key: { PK: `SESSION#${id}`, SK }, ConsistentRead: true }),
        { abortSignal: signal },
      )
    ).Item?.data as unknown;
  }
  async owned(id: string, owner: string, signal: AbortSignal): Promise<SessionRecord> {
    const value = await this.get(id, 'STATE', signal);
    if (
      value === undefined ||
      (value !== null && typeof value === 'object' && 'ownerId' in value && value.ownerId !== owner)
    )
      throw new ResultReadError('NOT_FOUND');
    if (
      !validSession(value) ||
      !validSessionRelations(value) ||
      value.ownerId !== owner ||
      value.view.id !== id ||
      value.accessGrant.timeLimitSeconds !== value.view.timeLimitSeconds
    )
      throw new Error('Invalid owned session.');
    return structuredClone(value);
  }
  async assistance(id: string, signal: AbortSignal): Promise<{ id: string; at: string; kind: string }[]> {
    const items: { id: string; at: string; kind: string }[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      signal.throwIfAborted();
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          ConsistentRead: true,
          Limit: 100,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
          ExpressionAttributeValues: { ':pk': `SESSION#${id}`, ':p': 'EVENT#' },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
        { abortSignal: signal },
      );
      for (const row of page.Items ?? []) {
        if (
          row.PK !== `SESSION#${id}` ||
          typeof row.SK !== 'string' ||
          !row.SK.startsWith('EVENT#') ||
          !validAssistance(row.data)
        )
          throw new Error('Invalid assistance event.');
        items.push(row.data as { id: string; at: string; kind: string });
      }
      if (
        items.length > 500 ||
        (page.LastEvaluatedKey &&
          (page.LastEvaluatedKey.PK !== `SESSION#${id}` ||
            typeof page.LastEvaluatedKey.SK !== 'string' ||
            !page.LastEvaluatedKey.SK.startsWith('EVENT#') ||
            (cursor && page.LastEvaluatedKey.SK <= (cursor.SK as string))))
      )
        throw new Error('Invalid assistance pagination.');
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async debrief(session: SessionRecord, signal: AbortSignal): Promise<Debrief> {
    if (['provisioning', 'ready'].includes(session.view.status)) throw new ResultReadError('SESSION_ACTIVE');
    if (session.view.readyAt === null) throw new ResultReadError('NOT_FOUND');
    if (!session.view.debriefAvailable) throw new ResultReadError('DEBRIEF_PENDING');
    const value = await this.get(session.view.id, 'DEBRIEF', signal);
    if (
      !isDebrief(value) ||
      value.sessionId !== session.view.id ||
      value.outcome !== session.view.status ||
      value.challenge.id !== session.view.challenge.id ||
      canonicalJson(value.challenge) !== canonicalJson(session.view.challenge) ||
      canonicalJson(value.recording) !== canonicalJson(session.view.recording) ||
      canonicalJson(value.attempt) !== canonicalJson(session.view.attempt) ||
      canonicalJson(value.assistance) !== canonicalJson(session.view.assistance)
    )
      throw new Error('Invalid saved debrief.');
    return structuredClone(value);
  }
}
export interface ReadContext {
  id: string;
  owner: string;
  signal: AbortSignal;
  event: APIGatewayProxyEvent;
}
export function createResultReadAction(
  operation: string,
  resource: string,
  read: (input: ReadContext) => Promise<object>,
  log: (value: { operation: string; requestId: string; result: string; durationMs: number }) => void = () => {},
) {
  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  ): Promise<APIGatewayProxyResult> => {
    const start = performance.now();
    const requestId = validUuid(context.awsRequestId) ? context.awsRequestId.toLowerCase() : randomUUID();
    let result = 'INTERNAL_ERROR';
    const response = (statusCode: number, body: object) => ({
      statusCode,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify(body),
    });
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new ResultReadError('UNAUTHENTICATED');
      if (
        event.httpMethod !== 'GET' ||
        event.resource !== resource ||
        event.body !== null ||
        event.isBase64Encoded === true ||
        !validUuid(event.pathParameters?.id)
      )
        throw new ResultReadError('INVALID_REQUEST');
      const available = context.getRemainingTimeInMillis() - 1000;
      const signal = available > 0 ? AbortSignal.timeout(available) : AbortSignal.abort();
      signal.throwIfAborted();
      const value = await read({ id: event.pathParameters!.id!.toLowerCase(), owner, signal, event });
      signal.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(value)) > playbackLimits.maximumResponseBytes)
        throw new Error('Result response bound exceeded.');
      result = 'read';
      return response(200, value);
    } catch (error) {
      const failure = error instanceof ResultReadError ? error : new ResultReadError('INTERNAL_ERROR');
      result = failure.code;
      const [status, message] = errors[failure.code];
      return response(status, {
        code: failure.code,
        message,
        requestId,
        ...(['DEBRIEF_PENDING', 'PLAYBACK_PENDING'].includes(failure.code) ? { retryAfterSeconds: 3 } : {}),
      });
    } finally {
      try {
        log({ operation, requestId, result, durationMs: Math.round(performance.now() - start) });
      } catch {
        /* Logs cannot change responses. */
      }
    }
  };
}
export function pageInput(event: APIGatewayProxyEvent, maximum: number) {
  const query =
    event.multiValueQueryStringParameters ??
    Object.fromEntries(Object.entries(event.queryStringParameters ?? {}).map(([k, v]) => [k, [v!]]));
  if (
    Object.keys(query).some((k) => !['cursor', 'limit'].includes(k)) ||
    Object.values(query).some((v) => !v || v.length !== 1)
  )
    throw new ResultReadError('INVALID_REQUEST');
  const raw = query.limit?.[0];
  const limit = raw === undefined ? maximum : Number(raw);
  if ((raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) || !Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
    throw new ResultReadError('INVALID_REQUEST');
  const cursor = query.cursor?.[0];
  if (cursor !== undefined && (cursor.length < 1 || cursor.length > 1000)) throw new ResultReadError('INVALID_CURSOR');
  return { limit, cursor };
}
