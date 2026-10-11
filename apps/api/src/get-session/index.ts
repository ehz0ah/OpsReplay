import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAwsTransport } from '../shared/aws.js';
import { createGetSessionHandler } from './handler.js';
import { DynamoSessionReader } from './store.js';

const table = process.env.SESSION_TABLE_NAME;
if (!table) throw new Error('SESSION_TABLE_NAME is required');

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
);

export const handler = createGetSessionHandler({
  store: new DynamoSessionReader(client, table),
  log: (entry) => console.info(JSON.stringify(entry)),
});
