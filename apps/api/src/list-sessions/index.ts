import { client, table } from '../bootstrap/runtime.js';
import { HistoryReader } from '../history/reader.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createListSessionsHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createListSessionsHandler(new HistoryReader(client, table!)),
  loadPublicApiPolicy(process.env),
);
