import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { backfillHistory } from '../apps/api/src/history/backfill.js';
const [table, owner, region, ...extra] = process.argv.slice(2);
if (
  !table ||
  !/^[A-Za-z0-9_.-]{3,255}$/.test(table) ||
  !owner ||
  !/^[A-Za-z0-9_-]{1,128}$/.test(owner) ||
  !region ||
  !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region) ||
  extra.length
)
  throw new Error('Use TABLE OWNER REGION.');
const client = new DynamoDBClient({ region, maxAttempts: 2 });
try {
  console.log(
    'Indexed ' +
      (await backfillHistory(DynamoDBDocumentClient.from(client), table, owner, AbortSignal.timeout(60000))) +
      ' owned receipts.',
  );
} finally {
  client.destroy();
}
