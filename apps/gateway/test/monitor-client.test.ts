import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { MonitorClient, MonitorClientError } from '../src/monitor-client.js';
import { MonitorControl } from '../../monitor/src/control.js';
import { Monitor } from '../../monitor/src/monitor.js';
import { createControlServer } from '../../monitor/src/server.js';
import type { MonitorConfig, Transport } from '../../monitor/src/types.js';
import { testTls } from '../../monitor/test/tls.js';

const secret = 's'.repeat(43);
const epoch = Date.parse('2026-10-07T00:00:00.000Z');
const config: MonitorConfig = {
  journeys: [{
    id: 'checkout',
    ratePerSecond: 1,
    steps: [{ method: 'GET', url: 'http://127.0.0.1/', expectStatus: [200], timeoutMs: 100 }],
  }],
  validators: [{ id: 'checkout-recovers', check: { kind: 'journey', journey: 'checkout' }, sustainSeconds: 60 }],
  probes: [{
    id: 'proxy', publicLabel: 'Storefront unavailable',
    check: { kind: 'tcp', host: '127.0.0.1', port: 80, timeoutMs: 100 }, graceSeconds: 2,
  }],
};
const transport: Transport = {
  http: async () => ({ status: 502, body: '' }),
  tcp: async () => true,
};
const metric = {
  type: 'metrics' as const,
  sample: { at: '2026-10-07T00:00:05.000Z', values: { request_rate: 1, error_rate: 100 } },
  counters: { totalRequests: 5, failedRequests: 5 },
  recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
};

function errorCode(code: MonitorClientError['code']): (error: unknown) => boolean {
  return error => error instanceof MonitorClientError && error.code === code;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) });
  response.end(body);
}

test('the gateway client uses one pinned TLS connection for the real monitor lifecycle', async t => {
  const tls = testTls();
  let now = epoch;
  const monitor = new Monitor(config, transport, { now: () => now });
  const control = new MonitorControl(monitor, { every: () => ({ close() {} }) });
  await control.initialise();
  const server = createControlServer(control, { key: tls.key, cert: tls.cert, secret, now: () => now });
  let connections = 0;
  server.on('connection', () => { connections++; });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret });
  t.after(async () => {
    client.close();
    await control.close();
    await close(server);
    tls.close();
  });

  assert.equal(await client.health(), 'ready');
  const firstStart = await client.start();
  assert.deepEqual(await client.start(), firstStart);
  const firstPage = await client.read(0);
  assert.deepEqual(firstPage.frames.map(value => value.sequence), [1]);
  const source = firstPage.frames[0]!.source;

  now += 5_000;
  monitor.tick();
  await immediate();
  const resumed = await client.read(firstPage.nextSequence, source);
  assert.deepEqual(resumed.frames.map(value => value.sequence), [2]);
  await assert.rejects(client.read(0, '11111111-1111-4111-8111-111111111111'), errorCode('invalid_response'));

  const cutoffAt = new Date(now).toISOString();
  const sealed = await client.seal(cutoffAt);
  assert.equal(sealed.cutoffAt, cutoffAt);
  assert.deepEqual(await client.seal(cutoffAt), sealed);
  await assert.rejects(client.seal(new Date(now + 1).toISOString()), errorCode('invalid_state'));
  assert.equal(connections, 1);
});

test('certificate verification finishes before the bearer secret is sent', async t => {
  const serverTls = testTls();
  const wrongTls = testTls();
  let requests = 0;
  const server = createServer({ key: serverTls.key, cert: serverTls.cert, minVersion: 'TLSv1.3' }, (_request, response) => {
    requests++;
    sendJson(response, 200, { status: 'ready' });
  });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: wrongTls.cert, secret });
  t.after(async () => {
    client.close();
    await close(server);
    wrongTls.close();
    serverTls.close();
  });

  await assert.rejects(client.health(), errorCode('tls_failed'));
  assert.equal(requests, 0);
});

test('authentication failure is stable and does not disclose the supplied secret', async t => {
  const tls = testTls();
  const control = {
    health: () => 'ready' as const,
    start: () => ({ startedAt: new Date(epoch).toISOString() }),
    read: () => ({ frames: [], nextSequence: 0, sealed: false }),
    seal: async (cutoffAt: string) => ({ cutoffAt, final: metric }),
  } as unknown as MonitorControl;
  const server = createControlServer(control, { key: tls.key, cert: tls.cert, secret });
  const port = await listen(server);
  const supplied = 'x'.repeat(43);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret: supplied });
  t.after(async () => {
    client.close();
    await close(server);
    tls.close();
  });

  await assert.rejects(client.health(), error => {
    assert.ok(error instanceof MonitorClientError);
    assert.equal(error.code, 'auth_failed');
    assert.ok(!error.message.includes(supplied));
    return true;
  });
});

test('a rejected gateway request is distinct from an invalid monitor response', async t => {
  const tls = testTls();
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' }, (_request, response) => {
    sendJson(response, 400, { code: 'INVALID_REQUEST', message: 'Invalid monitor request.' });
  });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret });
  t.after(async () => {
    client.close();
    await close(server);
    tls.close();
  });

  await assert.rejects(client.health(), errorCode('invalid_request'));
});

test('the client refuses a server limited to TLS 1.2', async t => {
  const tls = testTls();
  let requests = 0;
  const server = createServer({
    key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  }, (_request, response) => {
    requests++;
    sendJson(response, 200, { status: 'ready' });
  });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret });
  t.after(async () => {
    client.close();
    await close(server);
    tls.close();
  });

  await assert.rejects(client.health(), errorCode('tls_failed'));
  assert.equal(requests, 0);
});

test('an idempotent request retries one dropped connection and then reuses the socket', async t => {
  const tls = testTls();
  let requests = 0;
  let connections = 0;
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' }, (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    if (requests === 1) { request.socket.destroy(); return; }
    sendJson(response, 200, { status: 'ready' });
  });
  server.on('connection', () => { connections++; });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret });
  t.after(async () => {
    client.close();
    await close(server);
    tls.close();
  });

  assert.equal(await client.health(), 'ready');
  assert.equal(await client.health(), 'ready');
  assert.equal(requests, 3);
  assert.equal(connections, 2);
  client.close();
  await assert.rejects(client.health(), errorCode('closed'));
});

test('request timeout retries once while caller cancellation does not retry', async t => {
  const tls = testTls();
  let requests = 0;
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' }, () => { requests++; });
  const port = await listen(server);
  const timed = new MonitorClient({
    host: '127.0.0.1', port, certificate: tls.cert, secret, requestTimeoutMs: 100,
  });
  const cancelled = new MonitorClient({
    host: '127.0.0.1', port, certificate: tls.cert, secret, requestTimeoutMs: 1_000,
  });
  t.after(async () => {
    timed.close();
    cancelled.close();
    await close(server);
    tls.close();
  });

  await assert.rejects(timed.health(), errorCode('request_timeout'));
  assert.equal(requests, 2);

  const controller = new AbortController();
  const received = once(server, 'request');
  const pending = cancelled.health(controller.signal);
  await received;
  controller.abort();
  await assert.rejects(pending, errorCode('cancelled'));
  assert.equal(requests, 3);
});

test('a waiting seal does not block health checks on the monitor connection', { timeout: 10_000 }, async t => {
  const tls = testTls();
  const cutoffAt = '2026-10-07T00:00:05.000Z';
  let releaseSeal = () => {};
  let markSealReceived = () => {};
  const sealGate = new Promise<void>(resolve => { releaseSeal = resolve; });
  const sealReceived = new Promise<void>(resolve => { markSealReceived = resolve; });
  let connections = 0;
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' }, async (request, response) => {
    request.resume();
    if (request.url === '/v1/seal') {
      markSealReceived();
      await sealGate;
      sendJson(response, 200, { cutoffAt, final: metric });
      return;
    }
    assert.equal(request.url, '/healthz');
    sendJson(response, 200, { status: 'ready' });
  });
  server.on('connection', () => { connections++; });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret });
  t.after(async () => {
    releaseSeal();
    client.close();
    await close(server);
    tls.close();
  });

  const sealing = client.seal(cutoffAt);
  await sealReceived;
  const checking = client.health();
  let health: Awaited<typeof checking> | 'blocked';
  try {
    health = await Promise.race([checking, delay(1_000, 'blocked' as const)]);
  } finally {
    releaseSeal();
  }
  assert.equal(await checking, 'ready');
  assert.equal(await sealing.then(value => value.cutoffAt), cutoffAt);
  assert.equal(health, 'ready');
  assert.equal(connections, 2);
});

test('closing the client cancels active and agent-queued requests', { timeout: 10_000 }, async t => {
  const tls = testTls();
  let requests = 0;
  let closingServer = false;
  const sockets = new Set<Duplex>();
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' }, () => { requests++; });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (closingServer) socket.destroy();
  });
  const port = await listen(server);
  const client = new MonitorClient({
    host: '127.0.0.1', port, certificate: tls.cert, secret, requestTimeoutMs: 1_000,
  });
  t.after(async () => {
    closingServer = true;
    client.close();
    for (const socket of sockets) socket.destroy();
    await close(server);
    tls.close();
  });

  const firstReceived = once(server, 'request', { signal: AbortSignal.timeout(2_000) });
  const first = client.health();
  await firstReceived;
  const secondReceived = once(server, 'request', { signal: AbortSignal.timeout(2_000) });
  const second = client.health();
  await secondReceived;
  const third = client.health();
  const rejected = [first, second, third].map(pending => assert.rejects(pending, errorCode('closed')));
  client.close();
  await Promise.all(rejected);
  await immediate();
  assert.equal(requests, 2);
});

test('the client rejects malformed, oversized, and discontinuous responses', async t => {
  const tls = testTls();
  let mode: 'json' | 'oversized' | 'sequence' = 'json';
  const server = createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.3' }, (request, response) => {
    if (mode === 'json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{');
      return;
    }
    if (mode === 'oversized') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '65537' });
      response.end('{}');
      return;
    }
    assert.equal(request.url, '/v1/frames?after=0');
    sendJson(response, 200, {
      frames: [{
        source: '11111111-1111-4111-8111-111111111111', sequence: 2,
        recordedAt: '2026-10-07T00:00:05.000Z', payload: metric,
      }],
      nextSequence: 2,
      sealed: false,
    });
  });
  const port = await listen(server);
  const client = new MonitorClient({ host: '127.0.0.1', port, certificate: tls.cert, secret });
  t.after(async () => {
    client.close();
    await close(server);
    tls.close();
  });

  await assert.rejects(client.health(), errorCode('invalid_response'));
  mode = 'oversized';
  await assert.rejects(client.health(), errorCode('invalid_response'));
  mode = 'sequence';
  await assert.rejects(client.read(0), errorCode('invalid_response'));
});

test('configuration and operation inputs fail before network access', async () => {
  const tls = testTls();
  try {
    assert.throws(() => new MonitorClient({ host: 'localhost', certificate: tls.cert, secret }), errorCode('invalid_config'));
    assert.throws(() => new MonitorClient({ host: '127.0.0.1', certificate: 'invalid', secret }), errorCode('invalid_config'));
    const client = new MonitorClient({ host: '127.0.0.1', certificate: tls.cert, secret });
    try {
      await assert.rejects(client.read(-1), errorCode('invalid_config'));
      await assert.rejects(client.seal('2026-10-07'), errorCode('invalid_config'));
    } finally { client.close(); }
  } finally { tls.close(); }
});
