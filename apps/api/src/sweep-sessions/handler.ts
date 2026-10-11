import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { sessionLifecycle } from '../../../../packages/contracts/private/session-lifecycle.js';
import { unfinishedWorkIndex } from '../../../../packages/contracts/private/recording-work.js';
import { validUuid } from '../start-session/validation.js';
import type { ReconcileResult } from '../session-lifecycle/reconcile.js';
import { sendOptions } from '../shared/aws.js';
export function createSessionSweep({
  client,
  table,
  reconcile,
  report = () => {},
}: {
  client: DynamoDBDocumentClient;
  table: string;
  reconcile(id: string, signal?: AbortSignal): Promise<ReconcileResult>;
  report(value: { operation: 'sweep_sessions'; sessionId: string; result: string }): void;
}) {
  const cursorKey = { PK: 'LIFECYCLE_SWEEP', SK: 'CURSOR' };
  // Save bounded scan progress across cold starts. Concurrent sweeps can repeat
  // work, but all effects are conditional and every pass resets to the start.
  return async (_event: unknown, context: Pick<Context, 'getRemainingTimeInMillis'>) => {
    const available = context.getRemainingTimeInMillis() - 1000;
    const signal = available > 0 ? AbortSignal.timeout(available) : AbortSignal.abort();
    signal.throwIfAborted();
    const saved = (
      await client.send(new GetCommand({ TableName: table, Key: cursorKey, ConsistentRead: true }), sendOptions(signal))
    ).Item;
    const cursor: unknown = saved?.cursor;
    if (
      cursor !== undefined &&
      cursor !== null &&
      (typeof cursor !== 'object' ||
        Array.isArray(cursor) ||
        (cursor as Record<string, unknown>).WorkPK !== sessionLifecycle.workPartition ||
        typeof (cursor as Record<string, unknown>).WorkSK !== 'string' ||
        typeof (cursor as Record<string, unknown>).PK !== 'string' ||
        (cursor as Record<string, unknown>).SK !== sessionLifecycle.workSortKey)
    )
      throw new Error('Lifecycle sweep cursor is invalid.');
    const page = await client.send(
      new QueryCommand({
        TableName: table,
        IndexName: unfinishedWorkIndex.name,
        KeyConditionExpression: '#work = :lifecycle',
        ExpressionAttributeNames: { '#work': unfinishedWorkIndex.partitionKey },
        ExpressionAttributeValues: { ':lifecycle': sessionLifecycle.workPartition },
        ProjectionExpression: 'PK, SK',
        Limit: sessionLifecycle.maximumSweepItems,
        ...(cursor ? { ExclusiveStartKey: cursor as Record<string, unknown> } : {}),
      }),
      sendOptions(signal),
    );
    // Move discovery first so an invocation timeout cannot pin every subsequent
    // pass to the same page. Unfinished rows remain indexed for the next pass.
    await client.send(
      new PutCommand({ TableName: table, Item: { ...cursorKey, cursor: page.LastEvaluatedKey ?? null } }),
      sendOptions(signal),
    );
    let failed = false;
    const items = page.Items ?? [];
    for (let offset = 0; offset < items.length; offset += 5) {
      await Promise.all(
        items.slice(offset, offset + 5).map(async (item) => {
          const id = typeof item.PK === 'string' && item.PK.startsWith('SESSION#') ? item.PK.slice(8) : undefined;
          let result = 'failed';
          try {
            if (!validUuid(id) || item.SK !== sessionLifecycle.workSortKey)
              throw new Error('Lifecycle discovery item is invalid.');
            result = await reconcile(id, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
          } catch {
            failed = true;
          } finally {
            try {
              report({ operation: 'sweep_sessions', sessionId: validUuid(id) ? id : 'invalid', result });
            } catch {
              /* Reporting cannot change cleanup. */
            }
          }
        }),
      );
      signal.throwIfAborted();
    }
    if (failed) throw new Error('One or more lifecycle sessions need retry.');
  };
}
