import { createContext, useContext } from 'react';
import type { WebConfig } from './config.js';
export const ConfigContext = createContext<WebConfig | null>(null);
export function useConfig() {
  const config = useContext(ConfigContext);
  if (!config) throw new Error('Application configuration is missing.');
  return config;
}
