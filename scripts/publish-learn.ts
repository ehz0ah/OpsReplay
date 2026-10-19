import { readFile } from 'node:fs/promises';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { prepareLesson, type LearnEntry } from '../packages/content/src/learn.js';
import { publishLesson } from '../packages/content/src/learn-publish.js';
const [mode, path, table, bucket, region, ...extra] = process.argv.slice(2);
if (!['--prepare', '--apply'].includes(mode ?? '') || !path || extra.length)
  throw new Error('Use --prepare FILE or --apply FILE TABLE BUCKET REGION.');
const input = JSON.parse(await readFile(path, 'utf8')) as { body: string };
const entry = JSON.parse(input.body) as LearnEntry;
const prepared = prepareLesson(entry);
if (mode === '--prepare') {
  if (table || bucket || region) throw new Error('Prepare reads a local built lesson only.');
  console.log(JSON.stringify({ release: prepared.release, catalogue: prepared.catalogue }, null, 2));
} else {
  if (
    !table ||
    !/^[A-Za-z0-9_.-]{3,255}$/.test(table) ||
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !region ||
    !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region)
  )
    throw new Error('Explicit table, bucket and region are required.');
  const client = new DynamoDBClient({ region, maxAttempts: 2 });
  const s3 = new S3Client({ region, maxAttempts: 2 });
  try {
    await publishLesson(DynamoDBDocumentClient.from(client), table, s3, bucket, entry, AbortSignal.timeout(20000));
  } finally {
    client.destroy();
    s3.destroy();
  }
  console.log('Reviewed lesson published.');
}
