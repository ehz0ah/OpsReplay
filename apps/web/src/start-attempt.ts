import type { ApiClient } from './api.js';
import type { MutationJournal, PendingMutation } from './mutation-journal.js';
export async function startAttempt(
  api: ApiClient,
  journal: MutationJournal,
  value: PendingMutation & { kind: 'start' },
) {
  const pending = journal.begin(value);
  if (pending.kind !== 'start') throw new Error('Invalid start request.');
  try {
    const response = await api.mutate('SessionResponse', pending.path, pending.body);
    if (
      response.session.challenge.id !== pending.body.challengeId ||
      response.session.challenge.version !== pending.body.challengeVersion
    )
      throw new Error('The saved result does not match this Challenge. Recover current state before continuing.');
    journal.complete(pending);
    return response.session;
  } catch (error) {
    journal.reject(pending, error);
    throw error;
  }
}
