import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export function distribution(values: number[]) {
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measurement.');
  const sorted = values.slice().sort((a, b) => a - b);
  const quantile = (q: number) => (sorted.length ? sorted[Math.ceil(q * sorted.length) - 1]! : null);
  return {
    count: sorted.length,
    p50: quantile(0.5),
    p95: quantile(0.95),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}
/** Results contain test data. Refuse replacement and make files private. */
export async function saveReport(path: string, value: unknown) {
  const writer = await reserveReport(path);
  await writer(value);
}
/** Reserve before any live work. A repeated path must not spend money then fail. */
export async function reserveReport(path: string) {
  if (!path || !path.endsWith('.json')) throw new Error('Report path must end in .json.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  return async (value: unknown) => {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    } finally {
      await file.close();
    }
  };
}
export function exact(value: unknown, keys: string[]): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error('Invalid evaluation configuration.');
}
export function integer(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error('Invalid evaluation bound.');
}
