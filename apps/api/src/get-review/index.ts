import { client, table } from '../bootstrap/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { ReviewStore } from '../reviews/store.js';
import { createGetReviewHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createGetReviewHandler(new ReviewStore(client, table!)),
  loadPublicApiPolicy(process.env),
);
