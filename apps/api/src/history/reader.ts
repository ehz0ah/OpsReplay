import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { ActionError } from '../shared/action.js';
import { StartStore } from '../start-session/store.js';
import { ReviewStore } from '../reviews/store.js';
import { historyKey, isHistoryReference } from '../../../../packages/session/src/history.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
interface PagePosition {
  v: 1;
  owner: string;
  kind: string;
  upper: string;
  after: string;
}
function ownerHash(owner: string) {
  return createHash('sha256').update(owner).digest('hex');
}
export function historyParameters(event: APIGatewayProxyEvent, owner: string, kind: 'session' | 'review') {
  const query =
    event.multiValueQueryStringParameters ??
    Object.fromEntries(Object.entries(event.queryStringParameters ?? {}).map(([k, v]) => [k, [v]]));
  if (
    Object.keys(query).some((key) => !['limit', 'cursor'].includes(key)) ||
    Object.values(query).some((v) => !v || v.length !== 1 || typeof v[0] !== 'string')
  )
    throw new ActionError('INVALID_REQUEST');
  const raw = query.limit?.[0],
    limit = raw === undefined ? 50 : Number(raw);
  if ((raw !== undefined && !/^[1-9][0-9]*$/.test(raw)) || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ActionError('INVALID_REQUEST');
  const text = query.cursor?.[0];
  let position: PagePosition | undefined;
  if (text !== undefined) {
    try {
      if (text.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
      const bytes = Buffer.from(text, 'base64url');
      if (bytes.toString('base64url') !== text) throw new Error();
      const value = JSON.parse(bytes.toString());
      const pattern = new RegExp(`^HISTORY#${kind}#[0-9T:.Z-]+#[0-9a-f-]{36}$`);
      if (
        !value ||
        Object.keys(value).length !== 5 ||
        value.v !== 1 ||
        value.owner !== ownerHash(owner) ||
        value.kind !== kind ||
        !pattern.test(value.upper) ||
        !pattern.test(value.after) ||
        value.after > value.upper
      )
        throw new Error();
      position = value;
    } catch {
      throw new ActionError('INVALID_CURSOR');
    }
  }
  return { limit, position };
}
export class HistoryReader {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}
  async page(event: APIGatewayProxyEvent, owner: string, kind: 'session' | 'review', signal: AbortSignal) {
    const { limit, position } = historyParameters(event, owner, kind);
    const prefix = `HISTORY#${kind}#`;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        ConsistentRead: true,
        KeyConditionExpression: position
          ? 'PK = :pk AND SK BETWEEN :prefix AND :upper'
          : 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': 'USER#' + owner,
          ':prefix': prefix,
          ...(position ? { ':upper': position.upper } : {}),
        },
        ScanIndexForward: false,
        Limit: limit,
        ...(position ? { ExclusiveStartKey: { PK: 'USER#' + owner, SK: position.after } } : {}),
      }),
      { abortSignal: signal },
    );
    const rows = result.Items ?? [];
    const upper = position?.upper ?? rows[0]?.SK;
    const sessions: PublicTypes['SessionSummary'][] = [],
      reviews: PublicTypes['ReviewSubmissionSummary'][] = [];
    const start = new StartStore(this.client, this.table),
      review = new ReviewStore(this.client, this.table);
    for (const row of rows) {
      if (
        !isHistoryReference(row.data) ||
        row.PK !== 'USER#' + owner ||
        row.SK !== historyKey(owner, kind, row.data.at, row.data.id).SK
      )
        throw new Error('Invalid history reference.');
      if (kind === 'session') {
        const saved = await start.session(row.data.id, signal);
        if (!saved || saved.ownerId !== owner || saved.view.id !== row.data.id || saved.view.createdAt !== row.data.at)
          throw new Error('Invalid history ownership.');
        const view = saved.view;
        sessions.push({
          id: view.id,
          challenge: view.challenge,
          attempt: view.attempt,
          status: view.status,
          createdAt: view.createdAt,
          endedAt: view.endedAt,
        });
      } else {
        const saved = await review.owned(row.data.id, owner, signal);
        const view = saved.view;
        if (view.submittedAt !== row.data.at) throw new Error('Invalid review history time.');
        reviews.push({
          id: view.id,
          exerciseId: view.exerciseId,
          exerciseVersion: view.exerciseVersion,
          submittedAt: view.submittedAt,
          answerInformed: view.answerInformed,
          found: view.summary.found,
          missed: view.summary.missed,
        });
      }
    }
    let nextCursor: string | null = null;
    if (result.LastEvaluatedKey) {
      const next = result.LastEvaluatedKey;
      if (
        !upper ||
        next.PK !== 'USER#' + owner ||
        typeof next.SK !== 'string' ||
        !next.SK.startsWith(prefix) ||
        (position && next.SK >= position.after)
      )
        throw new Error('Invalid history continuation.');
      nextCursor = Buffer.from(JSON.stringify({ v: 1, owner: ownerHash(owner), kind, upper, after: next.SK })).toString(
        'base64url',
      );
    }
    return { items: kind === 'session' ? sessions : reviews, nextCursor };
  }
}
