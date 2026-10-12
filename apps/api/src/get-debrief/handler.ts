import { createResultReadAction, ResultReadError, type ResultReader } from '../result-reads/shared.js';
export function createGetDebriefHandler(store: ResultReader, log?: Parameters<typeof createResultReadAction>[3]) {
  return createResultReadAction(
    'get_debrief',
    '/v1/sessions/{id}/debrief',
    async ({ id, owner, signal, event }) => {
      if (
        Object.keys(event.queryStringParameters ?? {}).length ||
        Object.keys(event.multiValueQueryStringParameters ?? {}).length
      )
        throw new ResultReadError('INVALID_REQUEST');
      return store.debrief(await store.owned(id, owner, signal), signal);
    },
    log,
  );
}
