import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createStartHandler } from './handler.js';
import { StartStore } from './store.js';
import { createDynamoTransport } from './transport.js';

const table = process.env.SESSION_TABLE_NAME;
if (!table) throw new Error('SESSION_TABLE_NAME is required');

// Reuse only connections and compiled validators across invocations, never learner state.
// Runtime credentials come from the Lambda role. There is no local endpoint or identity bypass.
const client = DynamoDBDocumentClient.from(new DynamoDBClient({
  maxAttempts: 2,
  requestHandler: createDynamoTransport(),
}));
export const handler = createStartHandler({
  store: new StartStore(client, table),
  log: entry => console.info(JSON.stringify(entry)),
});
