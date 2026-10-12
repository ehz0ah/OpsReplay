import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createAwsTransport } from '../shared/aws.js';
import { ResultReader } from './shared.js';
export function createResultStore() {
  const table = process.env.SESSION_TABLE_NAME;
  if (!table) throw new Error('SESSION_TABLE_NAME is required.');
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
  );
  return new ResultReader(client, table);
}
export function createRecordingReads() {
  const bucket = process.env.RECORDING_BUCKET_NAME;
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    throw new Error('RECORDING_BUCKET_NAME is invalid.');
  const s3 = new S3Client({ maxAttempts: 2, requestHandler: createAwsTransport(2000) });
  return { bucket, s3 };
}
