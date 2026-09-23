import { createHash } from 'node:crypto';
import type { PublicTypes } from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';
import { ApiError } from './errors.js';

export function parse<K extends keyof PublicTypes>(name: K, input: unknown): PublicTypes[K] {
  const result = validatePublic(name, input);
  if (!result.ok) throw new ApiError('INVALID_REQUEST', `Invalid ${name}.`);
  return result.value;
}

export function output<K extends keyof PublicTypes>(
  name: K,
  input: PublicTypes[K],
): PublicTypes[K] {
  if (!validatePublic(name, input).ok) throw new Error(`Invalid server response: ${name}`);
  return input;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Cannot hash undefined data');
  return result;
}

export function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function boundedJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > 256 * 1024)
    throw new ApiError('LIMIT_EXCEEDED', 'This result exceeds the session storage limit.');
  return text;
}
