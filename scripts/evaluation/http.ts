import { performance } from 'node:perf_hooks';
import { exact, integer } from './report.js';
export interface LoadConfiguration {
  baseUrl: string;
  origin: string;
  concurrency: number;
  rounds: number;
  thinkTimeMs: number;
  timeoutMs: number;
  participants: { token: string; sessionId: string }[];
}
export function loadConfiguration(value: unknown): LoadConfiguration {
  exact(value, ['baseUrl', 'origin', 'concurrency', 'rounds', 'thinkTimeMs', 'timeoutMs', 'participants']);
  for (const name of ['baseUrl', 'origin']) {
    const url = new URL(value[name]);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (name === 'origin'
        ? url.pathname !== '/' || value[name] !== url.origin
        : !/^\/(?:[A-Za-z0-9_-]+)?$/.test(url.pathname) || value[name].endsWith('/'))
    )
      throw new Error('Use an exact HTTPS browser origin and API base with optional stage.');
  }
  integer(value.concurrency, 1, 100);
  integer(value.rounds, 1, 100);
  integer(value.thinkTimeMs, 0, 60000);
  integer(value.timeoutMs, 1000, 30000);
  if (!Array.isArray(value.participants) || value.participants.length !== value.concurrency)
    throw new Error('Provide one test session per worker.');
  for (const p of value.participants) {
    exact(p, ['token', 'sessionId']);
    if (
      typeof p.token !== 'string' ||
      p.token.length < 20 ||
      p.token.length > 20000 ||
      /[\r\n]/.test(p.token) ||
      typeof p.sessionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.sessionId)
    )
      throw new Error('Invalid test identity.');
  }
  if (
    new Set(value.participants.map((p) => p.sessionId)).size !== value.concurrency ||
    new Set(value.participants.map((p) => p.token)).size !== value.concurrency
  )
    throw new Error('Workers must use separate test learners and sessions.');
  return value as unknown as LoadConfiguration;
}
export async function jsonRequest(
  base: string,
  path: string,
  token: string,
  method: 'GET' | 'POST',
  signal: AbortSignal,
  transport = fetch,
) {
  const started = performance.now();
  const response = await transport(base + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Cache-Control': 'no-store' },
    signal,
    redirect: 'error',
  });
  const reader = response.body?.getReader();
  let bytes = 0,
    content = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    if (!reader) throw new Error('Empty API body.');
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 256 * 1024) throw new Error('API body exceeds bound.');
      content += decoder.decode(part.value, { stream: true });
    }
    content += decoder.decode();
    return { status: response.status, value: JSON.parse(content), durationMs: performance.now() - started };
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
