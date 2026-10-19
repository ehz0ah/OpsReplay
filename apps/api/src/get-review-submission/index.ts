import { client, table } from '../bootstrap/runtime.js';
import { ReviewStore } from '../reviews/store.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetReviewSubmissionHandler } from './handler.js';
export const handler = withPublicApiPolicy(
  createGetReviewSubmissionHandler(new ReviewStore(client, table!)),
  loadPublicApiPolicy(process.env),
);
