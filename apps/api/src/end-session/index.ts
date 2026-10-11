import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoAttemptStore } from '../../../../packages/session/src/attempt-store.js';
import { createAwsTransport } from '../shared/aws.js';
import { createEndSessionHandler } from './handler.js';
const table = process.env.SESSION_TABLE_NAME;
if (!table) throw new Error('SESSION_TABLE_NAME is required');
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 2, requestHandler: createAwsTransport(2000) }),
);
export const handler = createEndSessionHandler({
  store: new DynamoAttemptStore(client, table),
  log: (entry) => console.info(JSON.stringify(entry)),
});
