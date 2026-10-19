import { readFile } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { prepareReview, type ReviewBundle } from '../packages/content/src/review.js';
import { publishReview } from '../packages/content/src/review-publish.js';
const [mode, path, table, region, ...extra] = process.argv.slice(2);
if (!['--prepare', '--apply'].includes(mode ?? '') || !path || extra.length)
  throw new Error('Use --prepare FILE or --apply FILE TABLE REGION.');
const source = JSON.parse(await readFile(path, 'utf8')) as ReviewBundle;
const prepared = prepareReview(source);
if (mode === '--prepare') {
  if (table || region) throw new Error('Prepare uses only local content.');
  console.log(JSON.stringify({ pointer: prepared.pointer, catalogue: prepared.catalogue }, null, 2));
} else {
  if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !region || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region))
    throw new Error('Explicit table and region are required.');
  const client = new DynamoDBClient({ region, maxAttempts: 2 });
  try {
    await publishReview(DynamoDBDocumentClient.from(client), table, source, AbortSignal.timeout(20000));
  } finally {
    client.destroy();
  }
  console.log('Reviewed exercise published.');
}
