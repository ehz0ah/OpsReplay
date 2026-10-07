// Local gateway substitute for the real-container tests. It is not a runtime gateway.
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { writeJson } from '../src/output.js';
import { limits, MonitorError } from '../src/types.js';

const endpoint = 'https://127.0.0.1:9443';

interface Response<T> {
  status: number;
  value: T;
}
async function call<T>(path: string, method = 'GET', value?: object): Promise<Response<T>> {
  const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  const secret = process.env.OPSREPLAY_MONITOR_SECRET;
  const ca = process.env.OPSREPLAY_MONITOR_CA_B64;
  if (!secret || !ca) throw new MonitorError('invalid_config');
  return new Promise((resolve, reject) => {
    const req = request(
      endpoint + path,
      {
        method,
        ca: Buffer.from(ca, 'base64'),
        rejectUnauthorized: true,
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(body === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) }),
        },
        timeout: limits.controlRequestMs + 1000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) response.destroy(new MonitorError('output_failed'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T,
            });
          } catch {
            reject(new MonitorError('output_failed'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new MonitorError('output_failed')));
    req.on('error', reject);
    req.end(body);
  });
}

async function waitUntilReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await call<{ status?: string }>('/healthz');
      if (health.status === 200 && health.value.status === 'ready') return;
      if (health.value.status === 'failed') throw new MonitorError('initial_state_failed');
    } catch (error) {
      if (error instanceof MonitorError && error.code === 'initial_state_failed') throw error;
    }
    await delay(100);
  }
  throw new MonitorError('initial_state_failed');
}

async function main(): Promise<number> {
  let stop = false;
  const stopped = () => {
    stop = true;
  };
  process.on('SIGINT', stopped);
  process.on('SIGTERM', stopped);
  try {
    const timeout = Number(process.env.OPSREPLAY_MONITOR_CLIENT_START_TIMEOUT_MS ?? '30000');
    if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30_000) throw new MonitorError('invalid_config');
    await waitUntilReady(timeout);
    const started = await call<{ startedAt: string }>('/v1/start', 'POST');
    if (started.status !== 200) throw new MonitorError('monitor_failed');
    await writeJson(process.stdout, { type: 'monitor_started', at: started.value.startedAt });
    let cursor = 0;
    while (!stop) {
      const page = await call<{ frames: { sequence: number }[]; nextSequence: number }>('/v1/frames?after=' + cursor);
      if (page.status !== 200 || !Array.isArray(page.value.frames) || !Number.isInteger(page.value.nextSequence))
        throw new MonitorError('output_failed');
      for (const frame of page.value.frames) await writeJson(process.stdout, frame);
      cursor = page.value.nextSequence;
      await delay(100);
    }
    const cutoffAt = new Date().toISOString();
    const sealed = await call<{ final: object }>('/v1/seal', 'POST', { cutoffAt });
    if (sealed.status !== 200) throw new MonitorError('monitor_failed');
    while (true) {
      const page = await call<{ frames: { sequence: number }[]; nextSequence: number }>('/v1/frames?after=' + cursor);
      if (page.status !== 200 || !Array.isArray(page.value.frames)) throw new MonitorError('output_failed');
      for (const frame of page.value.frames) await writeJson(process.stdout, frame);
      cursor = page.value.nextSequence;
      if (page.value.frames.length === 0) break;
    }
    await writeJson(process.stdout, { type: 'monitor_sealed', final: sealed.value.final });
    return 0;
  } catch (error) {
    const code = error instanceof MonitorError ? error.code : 'monitor_failed';
    process.stderr.write(JSON.stringify({ type: 'monitor_error', code }) + '\n');
    return 1;
  } finally {
    process.removeListener('SIGINT', stopped);
    process.removeListener('SIGTERM', stopped);
  }
}

void main().then((code) => {
  if (code !== 0) process.exit(code);
});
