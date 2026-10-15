import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAwsTransport } from '../shared/aws.js';
export const table = process.env.SESSION_TABLE_NAME;
if (!table || !/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new Error('SESSION_TABLE_NAME is required');
export const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
);
