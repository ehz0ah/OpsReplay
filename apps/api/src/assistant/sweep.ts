import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { unfinishedWorkIndex } from '../../../../packages/contracts/private/recording-work.js';
import { validUuid } from '../start-session/validation.js';
import { AssistantStore } from './store.js';
export async function sweepAssistantTurns(
  client: DynamoDBDocumentClient,
  table: string,
  signal: AbortSignal,
  now = Date.now,
) {
  const rows = await client.send(
    new QueryCommand({
      TableName: table,
      IndexName: unfinishedWorkIndex.name,
      Limit: 25,
      KeyConditionExpression: 'WorkPK = :partition AND WorkSK <= :end',
      ExpressionAttributeValues: { ':partition': 'ASSISTANT', ':end': new Date(now()).toISOString() + '~' },
      ProjectionExpression: 'PK, SK',
    }),
    { abortSignal: signal },
  );
  const store = new AssistantStore(client, table, now);
  for (const row of rows.Items ?? []) {
    if (
      typeof row.PK !== 'string' ||
      !row.PK.startsWith('SESSION#') ||
      typeof row.SK !== 'string' ||
      !row.SK.startsWith('TURN#')
    )
      throw new Error('Invalid assistant discovery.');
    const id = row.PK.slice(8),
      turnId = row.SK.slice(5);
    if (!validUuid(id) || !validUuid(turnId)) throw new Error('Invalid assistant work identity.');
    const saved = await store.get(id, 'STATE', signal);
    if (!saved || typeof saved !== 'object' || !('ownerId' in saved) || typeof saved.ownerId !== 'string')
      throw new Error('Assistant owner missing.');
    await store.read(id, turnId, saved.ownerId, signal);
  }
}
