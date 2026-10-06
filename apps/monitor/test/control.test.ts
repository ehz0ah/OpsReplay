import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { MonitorControl } from '../src/control.js';
import type { ControlScheduler } from '../src/control.js';
import type { Frame } from '../src/monitor.js';
import { waitForRuntimeStop } from '../src/runtime-lifecycle.js';
import { createControlServer } from '../src/server.js';
import { limits, MonitorError } from '../src/types.js';
import type { FailureCode, MetricFrame } from '../src/types.js';
import { testTls } from './tls.js';

const secret = 's'.repeat(43);
const final: MetricFrame = {
  type: 'metrics',
  sample: { at: '2026-10-07T00:00:05.000Z', values: { request_rate: 2, error_rate: 0, latency_p95: 12 } },
  counters: { totalRequests: 10, failedRequests: 2 },
  recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
};

function frame(sequence: number): Frame {
  return {
    source: '11111111-1111-4111-8111-111111111111',
    sequence,
    recordedAt: Date.parse('2026-10-07T00:00:05.000Z') + sequence,
    payload: structuredClone(final),
  };
}

function fixture(ready = true, currentTime = () => Date.parse('2026-10-07T00:01:00.000Z')) {
  let ticks = 0;
  let timerClosed = 0;
  let failed: FailureCode | null = null;
  let cutoff: number | undefined;
  const frames = Array.from({ length: 105 }, (_, index) => frame(index + 1));
  const monitor = {
    get failure() { return failed; },
    now: currentTime,
    async verifyInitialState() { return ready; },
    start() { return Date.parse('2026-10-07T00:00:00.000Z'); },
    tick() { ticks++; },
    read(after = 0, limit = frames.length - after) {
      if (!Number.isInteger(after) || after < 0 || after > frames.length) throw new MonitorError('invalid_boundary');
      return structuredClone(frames.slice(after, after + limit));
    },
    async seal(at?: number) {
      if (at === undefined || at < Date.parse('2026-10-07T00:00:00.000Z') || at > Date.parse('2026-10-07T00:01:00.000Z')) {
        throw new MonitorError('invalid_boundary');
      }
      cutoff ??= at;
      if (cutoff !== at) throw new MonitorError('invalid_boundary');
      return structuredClone(final);
    },
    fail(code: FailureCode) { failed ??= code; },
    async drain() {},
  };
  const scheduler: ControlScheduler = {
    every(callback, intervalMs) {
      assert.equal(intervalMs, 25);
      callback();
      return { close: () => { timerClosed++; } };
    },
  };
  const control = new MonitorControl(monitor, scheduler);
  return { control, get ticks() { return ticks; }, get timerClosed() { return timerClosed; },
    get failed() { return failed; }, get cutoff() { return cutoff; } };
}

test('control initialises, starts once, pages frames, and seals one immutable cutoff', async () => {
  const f = fixture();
  assert.equal(f.control.health(), 'starting');
  await f.control.initialise();
  assert.equal(f.control.health(), 'ready');
  const started = f.control.start();
  assert.deepEqual(f.control.start(), started);
  assert.equal(f.ticks, 2);
  await assert.rejects(f.control.seal('2026-10-06T23:59:59.999Z'), /invalid_boundary/);
  await assert.rejects(f.control.seal('2026-10-07'), /invalid_boundary/);
  const first = f.control.read(0);
  assert.equal(first.frames.length, 100);
  assert.equal(first.nextSequence, 100);
  assert.equal(first.frames[0]!.recordedAt, '2026-10-07T00:00:05.001Z');
  const second = f.control.read(first.nextSequence);
  assert.deepEqual(second.frames.map(value => value.sequence), [101, 102, 103, 104, 105]);
  assert.equal(second.sealed, false);
  const sealed = await f.control.seal('2026-10-07T00:00:05.000Z');
  assert.deepEqual(await f.control.seal('2026-10-07T00:00:05.000Z'), sealed);
  await assert.rejects(f.control.seal('2026-10-07T00:00:06.000Z'), /invalid_boundary/);
  assert.equal(f.control.read(105).sealed, true);
  assert.equal(f.timerClosed, 1);
  await f.control.close();
  assert.equal(f.failed, null);
});

test('control fails closed before readiness and when stopped without a lifecycle cutoff', async () => {
  const f = fixture(false);
  await f.control.initialise();
  assert.equal(f.control.health(), 'failed');
  assert.throws(() => f.control.start(), /invalid_boundary/);
  await f.control.close();
  assert.equal(f.failed, 'monitor_failed');
});

test('control waits for a slightly future lifecycle cutoff without changing it', async () => {
  let now = Date.parse('2026-10-07T00:00:05.000Z');
  const f = fixture(true, () => now);
  await f.control.initialise();
  f.control.start();
  await assert.rejects(
    f.control.seal(new Date(now + limits.controlCutoffLeadMs + 1).toISOString()),
    /invalid_boundary/,
  );
  const cutoff = now + 10;
  const sealing = f.control.seal(new Date(cutoff).toISOString());
  const replay = f.control.seal(new Date(cutoff).toISOString());
  assert.equal(f.control.read(0).sealed, false);
  queueMicrotask(() => { now = cutoff; });
  const [sealed, replayed] = await Promise.all([sealing, replay]);
  assert.equal(sealed.cutoffAt, '2026-10-07T00:00:05.010Z');
  assert.deepEqual(replayed, sealed);
  assert.equal(f.cutoff, cutoff);
  assert.equal(f.control.read(0).sealed, true);
});

test('runtime stops on a control-server error and removes pending listeners', async () => {
  const server = new EventEmitter();
  const signals = new EventEmitter();
  const stopped = waitForRuntimeStop(server, signals);
  const failure = new Error('control server failed');
  server.emit('error', failure);
  await assert.rejects(stopped, failure);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('runtime stops on a process signal and removes the server error listener', async () => {
  const server = new EventEmitter();
  const signals = new EventEmitter();
  const stopped = waitForRuntimeStop(server, signals);
  signals.emit('SIGTERM');
  await stopped;
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

interface Result { status: number; body: unknown }
async function request(port: number, cert: Buffer, path: string, options: {
  method?: string; secret?: string; body?: string; trusted?: boolean;
} = {}): Promise<Result> {
  const content = options.body;
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET',
      ca: options.trusted === false ? undefined : cert,
      rejectUnauthorized: true,
      headers: {
        ...(options.secret === undefined ? {} : { Authorization: `Bearer ${options.secret}` }),
        ...(content === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content) }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(content);
  });
}

test('HTTPS control API authenticates, resumes by cursor, seals idempotently, and bounds invalid traffic', async t => {
  const tls = testTls();
  t.after(() => tls.close());
  const f = fixture();
  await f.control.initialise();
  let now = 1000;
  const server = createControlServer(f.control, { key: tls.key, cert: tls.cert, secret, now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as AddressInfo).port;

  assert.deepEqual(await request(port, tls.cert, '/healthz'), { status: 200, body: { status: 'ready' } });
  const wrong = await request(port, tls.cert, '/v1/start', { method: 'POST', secret: 'x'.repeat(43) });
  assert.equal(wrong.status, 401);
  assert.deepEqual(Object.keys(wrong.body as object).sort(), ['code', 'message']);
  await assert.rejects(request(port, tls.cert, '/healthz', { trusted: false }), /self-signed certificate/);
  await assert.rejects(new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/healthz' }, resolve);
    req.on('error', reject);
    req.end();
  }));

  const started = await request(port, tls.cert, '/v1/start', { method: 'POST', secret });
  assert.equal(started.status, 200);
  assert.deepEqual(await request(port, tls.cert, '/v1/start', { method: 'POST', secret }), started);
  const page = await request(port, tls.cert, '/v1/frames?after=100', { secret });
  assert.equal(page.status, 200);
  assert.deepEqual((page.body as { frames: { sequence: number }[] }).frames.map(value => value.sequence), [101, 102, 103, 104, 105]);
  assert.ok(!JSON.stringify(page.body).includes('private'));
  assert.equal((await request(port, tls.cert, '/v1/frames?after=-1', { secret })).status, 400);
  assert.equal((await request(port, tls.cert, '/v1/frames?after=0&after=1', { secret })).status, 400);
  assert.equal((await request(port, tls.cert, '/v1/frames?after=0', { secret, body: '{}' })).status, 400);
  assert.equal((await request(port, tls.cert, '/v1/seal', {
    method: 'POST', secret, body: ' '.repeat(limits.controlBodyBytes + 1),
  })).status, 400);
  assert.equal((await request(port, tls.cert, '/v1/seal', {
    method: 'POST', secret, body: JSON.stringify({ cutoffAt: '2026-10-07T00:00:05.000Z', extra: true }),
  })).status, 400);
  assert.equal((await request(port, tls.cert, '/v1/seal', {
    method: 'POST', secret, body: JSON.stringify({ cutoffAt: '2026-10-07' }),
  })).status, 400);
  const sealed = await request(port, tls.cert, '/v1/seal', {
    method: 'POST', secret, body: JSON.stringify({ cutoffAt: '2026-10-07T00:00:05.000Z' }),
  });
  assert.equal(sealed.status, 200);
  assert.deepEqual(await request(port, tls.cert, '/v1/seal', {
    method: 'POST', secret, body: JSON.stringify({ cutoffAt: '2026-10-07T00:00:05.000Z' }),
  }), sealed);
  assert.equal((await request(port, tls.cert, '/v1/seal', {
    method: 'POST', secret, body: JSON.stringify({ cutoffAt: '2026-10-07T00:00:06.000Z' }),
  })).status, 409);

  now = 2000;
  const unauthenticated = await Promise.all(Array.from({ length: 9 }, () => request(port, tls.cert, '/healthz')));
  assert.equal(unauthenticated.filter(result => result.status === 429).length, 1);
  assert.equal(f.failed, null);
});
