import * as validators from '../../.local/contracts/public-validators.js';
import type { PublicTypes } from './public-types.js';
export type BrowserType = keyof typeof validators;
export function parsePublic<K extends BrowserType>(name: K, value: unknown): PublicTypes[K] {
  if (!validators[name](value)) throw new Error('The server response does not match the public contract.');
  return value as PublicTypes[K];
}
