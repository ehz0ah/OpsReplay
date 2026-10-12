import { createResultStore, createRecordingReads } from '../result-reads/runtime.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createGetPlaybackHandler } from './handler.js';
const { bucket, s3 } = createRecordingReads();
export const handler = withPublicApiPolicy(
  createGetPlaybackHandler(createResultStore(), s3, bucket, undefined, undefined, (entry) =>
    console.info(JSON.stringify(entry)),
  ),
  loadPublicApiPolicy(process.env),
);
