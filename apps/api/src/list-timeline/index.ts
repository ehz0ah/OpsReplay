import { createResultStore, createRecordingReads } from '../result-reads/runtime.js';
import { RecordedEvidenceReader } from '../../../../packages/session/src/recorded-evidence.js';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../shared/public-api.js';
import { createListTimelineHandler } from './handler.js';
const store = createResultStore();
const { bucket, s3 } = createRecordingReads();
export const handler = withPublicApiPolicy(
  createListTimelineHandler(store, new RecordedEvidenceReader(store.client, store.table, s3, bucket), (entry) =>
    console.info(JSON.stringify(entry)),
  ),
  loadPublicApiPolicy(process.env),
);
