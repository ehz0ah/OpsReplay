import type { ApiClient } from './api.js';
import { ApiError } from './api.js';
import type { MutationJournal } from './mutation-journal.js';
export async function releaseHint(api: ApiClient, journal: MutationJournal, id: string) {
  const pending = journal.begin({
    kind: 'hint',
    path: `/v1/sessions/${id}/hints`,
    body: { requestId: crypto.randomUUID() },
  });
  try {
    const result = await api.mutate('HintResponse', pending.path, pending.body);
    journal.complete(pending);
    return result;
  } catch (error) {
    journal.reject(pending, error);
    if (
      error instanceof ApiError &&
      error.detail.requestId === pending.body.requestId &&
      ['HINT_NOT_AVAILABLE', 'NO_HINTS_REMAINING', 'SESSION_NOT_READY', 'SESSION_TERMINAL'].includes(error.detail.code)
    )
      journal.complete(pending);
    throw error;
  }
}
