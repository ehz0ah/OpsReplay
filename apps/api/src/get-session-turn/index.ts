import { client, table } from '../bootstrap/runtime.js';
import { AssistantStore } from '../assistant/store.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetSessionTurnHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createGetSessionTurnHandler(new AssistantStore(client, table!)),
  loadPublicApiPolicy(process.env),
);
