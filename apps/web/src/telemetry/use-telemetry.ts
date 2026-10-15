import { useCallback, useEffect, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useApi } from '../api-context.js';
import { mergeSamples, mergeTimeline } from './state.js';
import { observeTimeline } from './timeline.js';
export function useTelemetry(id: string, enabled: boolean) {
  const api = useApi();
  const [samples, setSamples] = useState<PublicTypes['MetricSample'][]>([]),
    [events, setEvents] = useState<PublicTypes['TimelineEvent'][]>([]),
    [connected, setConnected] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setSamples([]);
    setEvents([]);
    setConnected(false);
    setError(null);
    setUnavailable(false);
    if (enabled)
      void observeTimeline(api, id, controller.signal, (items, failure) => {
        setEvents((current) => mergeTimeline(current, items));
        setError(failure);
      });
    return () => controller.abort();
  }, [api, id, enabled]);
  const frame = useCallback((value: PublicTypes['GatewayServerMessage']) => {
    if (value.type === 'metrics') {
      setSamples((current) => mergeSamples(current, value.sample));
      setUnavailable(false);
    }
    if (value.type === 'timeline') setEvents((current) => mergeTimeline(current, [value.event]));
    if (value.type === 'error' && value.code === 'TELEMETRY_UNAVAILABLE') setUnavailable(true);
  }, []);
  return {
    samples,
    events,
    connected,
    error,
    unavailable,
    frame,
    connection: useCallback((value: boolean) => setConnected(value), []),
  };
}
