import { createResultStore, createRecordingReads } from '../result-reads/runtime.js';
import { createGetPlaybackHandler } from './handler.js';
const { bucket, s3 } = createRecordingReads();
export const handler = createGetPlaybackHandler(createResultStore(), s3, bucket, undefined, undefined, (entry) =>
  console.info(JSON.stringify(entry)),
);
