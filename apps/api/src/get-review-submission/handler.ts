import { actionHandler, noQuery, ActionError } from '../shared/action.js';
import { validUuid } from '../start-session/validation.js';
import type { ReviewStore } from '../reviews/store.js';
export function createGetReviewSubmissionHandler(store: ReviewStore) {
  return actionHandler('GET', '/v1/review-submissions/{id}', async (event, owner, signal) => {
    noQuery(event);
    const id = event.pathParameters?.id;
    if (!validUuid(id)) throw new ActionError('INVALID_REQUEST');
    return (await store.owned(id.toLowerCase(), owner, signal)).view;
  });
}
