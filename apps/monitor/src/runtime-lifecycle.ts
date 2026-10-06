import { once } from 'node:events';
import type { EventEmitter } from 'node:events';

export async function waitForRuntimeStop(server: EventEmitter, signals: EventEmitter = process): Promise<void> {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  try {
    await Promise.race([
      once(signals, 'SIGINT', options),
      once(signals, 'SIGTERM', options),
      once(server, 'error', options).then(([error]) => { throw error; }),
    ]);
  } finally {
    controller.abort();
  }
}
