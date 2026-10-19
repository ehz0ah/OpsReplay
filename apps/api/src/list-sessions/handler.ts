import { actionHandler } from '../shared/action.js';
import type { HistoryReader } from '../history/reader.js';
export function createListSessionsHandler(reader: HistoryReader) {
  return actionHandler('GET', '/v1/sessions', (event, owner, signal) => reader.page(event, owner, 'session', signal));
}
