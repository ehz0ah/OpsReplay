import { client, table } from '../bootstrap/runtime.js';
import { HistoryReader } from '../history/reader.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createListReviewSubmissionsHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createListReviewSubmissionsHandler(new HistoryReader(client, table!)),
  loadPublicApiPolicy(process.env),
);
