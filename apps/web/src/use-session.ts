import { useCallback, useEffect, useState } from 'react';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import { useApi } from './api-context.js';
import { observeSession } from './lifecycle.js';
export function useSession(id: string) {
  const api = useApi(),
    [revision, setRevision] = useState(0);
  const [view, setView] = useState<PublicTypes['SessionView'] | null>(null),
    [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void observeSession(api, id, controller.signal, (value, failure) => {
      if (value) setView(value);
      setError(failure);
    });
    return () => controller.abort();
  }, [api, id, revision]);
  return { view, error, refresh: useCallback(() => setRevision((value) => value + 1), []) };
}
