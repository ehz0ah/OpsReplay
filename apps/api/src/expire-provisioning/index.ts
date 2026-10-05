import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { FargateEnvironment, createEcsClient } from '../session-lifecycle/aws-environment.js';
import { createExpireProvisioning } from '../session-lifecycle/expire.js';
import { LifecycleStore } from '../session-lifecycle/store.js';
import { createDynamoTransport } from '../start-session/transport.js';
import { createExpiryHandler } from './handler.js';

const table = process.env.SESSION_TABLE_NAME;
if (!table) throw new Error('SESSION_TABLE_NAME is required');

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({
  maxAttempts: 2,
  requestHandler: createDynamoTransport(),
}));
const expire = createExpireProvisioning({
  store: new LifecycleStore(dynamo, table),
  environment: new FargateEnvironment(createEcsClient()),
});

export const handler = createExpiryHandler({
  expire,
  log: entry => console.info(JSON.stringify(entry)),
});
