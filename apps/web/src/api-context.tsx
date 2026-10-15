import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { ApiClient } from './api.js';
import { useConfig } from './config-context.js';
import { useAuth } from './auth/provider.js';
const ApiContext = createContext<ApiClient | null>(null);
export function ApiProvider({ children }: { children: ReactNode }) {
  const config = useConfig(),
    auth = useAuth();
  const api = useMemo(() => new ApiClient(config.apiBaseUrl, () => auth.session.token()), [config, auth.session]);
  return <ApiContext value={api}>{children}</ApiContext>;
}
export function useApi() {
  const api = useContext(ApiContext);
  if (!api) throw new Error('API context is missing.');
  return api;
}
