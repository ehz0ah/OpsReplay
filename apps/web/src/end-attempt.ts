import type { ApiClient } from './api.js';
import type { MutationJournal } from './mutation-journal.js';
import { terminal } from './lifecycle.js';
export async function endAttempt(api: ApiClient, journal: MutationJournal, id: string) {
  const pending = journal.begin({
    kind: 'end',
    path: `/v1/sessions/${id}/end`,
    body: { requestId: crypto.randomUUID() },
  });
  try {
    const response = await api.mutate('EndSessionResponse', pending.path, pending.body);
    if (response.session.id !== id || !terminal(response.session.status))
      throw new Error('The outcome is not confirmed. Read current state before retrying the same end request.');
    journal.complete(pending);
    return response.session;
  } catch (error) {
    journal.reject(pending, error);
    throw error;
  }
}
