import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { validSession, validSessionRelations } from '../start-session/validation.js';
import { isReviewSubmission } from '../../../../packages/content/src/review.js';
import { historyKey } from '../../../../packages/session/src/history.js';
/** Explicit owner-scoped migration. No table scan, no outcome edits, no resource creation. */
export async function backfillHistory(
  client: DynamoDBDocumentClient,
  table: string,
  owner: string,
  signal: AbortSignal,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid history owner.');
  let count = 0;
  for (const [kind, prefix, partition] of [
    ['session', 'START#', 'SESSION'],
    ['review', 'REVIEWREQ#', 'REVIEW'],
  ] as const) {
    let after: Record<string, unknown> | undefined;
    for (let page = 0; ; page++) {
      if (page >= 100) throw new Error('History migration exceeds its page bound.');
      const result = await client.send(
        new QueryCommand({
          TableName: table,
          ConsistentRead: true,
          Limit: 100,
          KeyConditionExpression: 'PK = :owner AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':owner': 'USER#' + owner, ':prefix': prefix },
          ...(after ? { ExclusiveStartKey: after } : {}),
        }),
        { abortSignal: signal },
      );
      for (const row of result.Items ?? []) {
        const id = kind === 'session' ? row.data?.sessionId : row.data?.id;
        if (typeof id !== 'string') throw new Error('Invalid history receipt.');
        const saved = (
          await client.send(
            new GetCommand({ TableName: table, Key: { PK: partition + '#' + id, SK: 'STATE' }, ConsistentRead: true }),
            { abortSignal: signal },
          )
        ).Item?.data;
        if (!saved || saved.ownerId !== owner) throw new Error('History receipt ownership mismatch.');
        if (
          kind === 'session'
            ? !validSession(saved) || !validSessionRelations(saved) || saved.view.id !== id
            : !isReviewSubmission(saved.view) || saved.view.id !== id
        )
          throw new Error('Invalid history source.');
        const at = kind === 'session' ? saved.view?.createdAt : saved.view?.submittedAt;
        const Key = historyKey(owner, kind, at, id),
          data = { schemaVersion: 1, id, at };
        await client.send(
          new PutCommand({
            TableName: table,
            Item: { ...Key, data },
            ConditionExpression: 'attribute_not_exists(PK) OR #d = :same',
            ExpressionAttributeNames: { '#d': 'data' },
            ExpressionAttributeValues: { ':same': data },
          }),
          { abortSignal: signal },
        );
        count++;
      }
      if (!result.LastEvaluatedKey) break;
      if (
        result.LastEvaluatedKey.PK !== 'USER#' + owner ||
        typeof result.LastEvaluatedKey.SK !== 'string' ||
        !result.LastEvaluatedKey.SK.startsWith(prefix) ||
        (after && result.LastEvaluatedKey.SK <= String(after.SK))
      )
        throw new Error('Invalid migration continuation.');
      after = result.LastEvaluatedKey;
    }
  }
  return count;
}
