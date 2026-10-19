import { actionHandler } from '../shared/action.js';
import type { HistoryReader } from '../history/reader.js';
export function createListReviewSubmissionsHandler(reader: HistoryReader) {
  return actionHandler('GET', '/v1/review-submissions', (event, owner, signal) =>
    reader.page(event, owner, 'review', signal),
  );
}
