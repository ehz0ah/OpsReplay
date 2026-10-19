import { actionHandler, contentId, noQuery, ActionError } from '../shared/action.js';
import { isReviewRequest } from '../../../../packages/content/src/review.js';
import type { ReviewStore } from '../reviews/store.js';
export function createSubmitReviewHandler(store: ReviewStore) {
  return actionHandler('POST', '/v1/reviews/{id}/submissions', async (event, owner, signal) => {
    noQuery(event);
    const id = contentId(event);
    if (!event.body || Buffer.byteLength(event.body) > 128 * 1024) throw new ActionError('INVALID_REQUEST');
    let request: unknown;
    try {
      request = JSON.parse(event.body);
    } catch {
      throw new ActionError('INVALID_REQUEST');
    }
    if (!isReviewRequest(request)) throw new ActionError('INVALID_REQUEST');
    return store.submit(id, request, owner, signal);
  });
}
