import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createAwsTransport } from '../shared/aws.js';
import { createDeletionHandler } from './handler.js';
import { SessionDeletion } from './service.js';

const table = process.env.SESSION_TABLE_NAME,
  bucket = process.env.RECORDING_BUCKET_NAME;
if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
  throw new Error('Invalid deletion configuration.');
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport() }),
);
const s3 = new S3Client({ maxAttempts: 2, requestHandler: createAwsTransport() });
export const handler = createDeletionHandler(new SessionDeletion(dynamo, table, s3, bucket));
