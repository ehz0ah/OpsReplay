import { actionHandler, contentId, noQuery } from '../shared/action.js';
import type { ReviewStore } from '../reviews/store.js';
export function createGetReviewHandler(store: ReviewStore) {
  return actionHandler('GET', '/v1/reviews/{id}', async (event, owner, signal) => {
    noQuery(event);
    return store.exercise(contentId(event), owner, signal);
  });
}
