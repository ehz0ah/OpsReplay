import { useCallback, useEffect, useState } from 'react';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import type { BrowserType } from '../../../packages/contracts/public-validation.js';
import { useApi } from './api-context.js';
export function useRead<K extends BrowserType>(type: K, path: string, enabled = true) {
  const api = useApi(),
    [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ data: PublicTypes[K] | null; loading: boolean; error: Error | null }>({
    data: null,
    loading: enabled,
    error: null,
  });
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    setState({ data: null, loading: enabled, error: null });
    if (enabled)
      void api
        .read(type, path, controller.signal)
        .then((data) => {
          if (!stopped) setState({ data, loading: false, error: null });
        })
        .catch((error) => {
          if (!stopped)
            setState({
              data: null,
              loading: false,
              error: error instanceof Error ? error : new Error('The request failed.'),
            });
        });
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [api, type, path, enabled, revision]);
  return { ...state, reload: useCallback(() => setRevision((v) => v + 1), []) };
}
