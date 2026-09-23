import { QueryClient } from '@tanstack/react-query';
import { validatePublic } from '@opsreplay/contracts/validation';

export function createLearnerClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15000 } },
  });
  // Query reads and write receipts can arrive out of order. Apply the same guard
  // at the cache boundary so neither can replace a newer displayed session.
  client.setQueryDefaults(['session'], {
    structuralSharing: (previous, incoming) => {
      const oldSession = validatePublic('SessionView', previous);
      const newSession = validatePublic('SessionView', incoming);
      if (
        oldSession.ok &&
        newSession.ok &&
        oldSession.value.id === newSession.value.id &&
        oldSession.value.version > newSession.value.version
      )
        return previous;
      return incoming;
    },
  });
  return client;
}
