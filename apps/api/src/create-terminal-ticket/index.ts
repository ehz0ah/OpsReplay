import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAwsTransport } from '../shared/aws.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { loadTerminalTicketConfiguration } from './configuration.js';
import { createTerminalTicketHandler } from './handler.js';
import { DynamoTerminalTicketStore } from './store.js';

const table = process.env.SESSION_TABLE_NAME;
if (!table) throw new Error('SESSION_TABLE_NAME is required');

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    maxAttempts: 2,
    requestHandler: createAwsTransport(2000),
  }),
);

export const handler = withPublicApiPolicy(
  createTerminalTicketHandler({
    store: new DynamoTerminalTicketStore(client, table),
    ...loadTerminalTicketConfiguration(process.env),
    log: (entry) => console.info(JSON.stringify(entry)),
  }),
  loadPublicApiPolicy(process.env),
);
