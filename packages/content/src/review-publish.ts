import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { retryDynamoConflict } from '../../dynamodb/src/conflict-retry.js';
import { canonicalJson } from '../../session/src/canonical.js';
import { prepareReview, reviewKeys, type ReviewBundle } from './review.js';
import { catalogueKey } from './catalogue.js';
export async function publishReview(
  client: DynamoDBDocumentClient,
  table: string,
  source: ReviewBundle,
  signal: AbortSignal,
) {
  const prepared = prepareReview(source);
  const before = (
    await client.send(
      new GetCommand({ TableName: table, Key: reviewKeys.published(source.id), ConsistentRead: true }),
      { abortSignal: signal },
    )
  ).Item?.data;
  if (before && canonicalJson(before) !== canonicalJson(prepared.pointer))
    throw new Error('A different exercise is already published.');
  const items = [
    [reviewKeys.version(source.id, source.version), prepared.bundle],
    [reviewKeys.published(source.id), prepared.pointer],
    [catalogueKey(prepared.catalogue), prepared.catalogue],
  ] as const;
  await retryDynamoConflict(
    () =>
      client.send(
        new TransactWriteCommand({
          TransactItems: items.map(([Key, data]) => ({
            Put: {
              TableName: table,
              Item: { ...Key, data },
              ConditionExpression: 'attribute_not_exists(PK) OR #d = :same',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':same': data },
            },
          })),
        }),
        { abortSignal: signal },
      ),
    signal,
  );
}
