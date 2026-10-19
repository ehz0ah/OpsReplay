import { actionHandler, noQuery, ActionError } from '../shared/action.js';
import { validUuid } from '../start-session/validation.js';
import type { AssistantStore } from '../assistant/store.js';
export function createGetSessionTurnHandler(store: AssistantStore) {
  return actionHandler('GET', '/v1/sessions/{id}/messages/{turnId}', async (event, owner, signal) => {
    noQuery(event);
    const id = event.pathParameters?.id,
      turn = event.pathParameters?.turnId;
    if (!validUuid(id) || !validUuid(turn)) throw new ActionError('INVALID_REQUEST');
    return (await store.read(id, turn, owner, signal)).view;
  });
}
