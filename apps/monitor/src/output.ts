import type { Writable } from 'node:stream';
import { MonitorError, limits } from './types.js';

// Used by the local harness. The future TLS adapter can consume Monitor.read().
export async function writeJson(stream: Writable, value: unknown, timeoutMs = 1000): Promise<void> {
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > limits.bodyBytes) throw new MonitorError('output_failed');
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        // Writable may emit its error after invoking the write callback.
        stream.destroy();
        setImmediate(() => stream.removeListener('error', failed));
        reject(new MonitorError('output_failed'));
      } else {
        stream.removeListener('error', failed);
        resolve();
      }
    };
    const failed = () => done(new MonitorError('output_failed'));
    const timer = setTimeout(failed, timeoutMs);
    stream.once('error', failed);
    try {
      stream.write(line, done);
    } catch {
      failed();
    }
  });
}
