import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import {
  GatewayBrowserTerminalConnection,
  GatewayBrowserTerminalRelay,
  type BrowserTerminalSession,
  type BrowserTerminalSessionOpener,
  type GatewayBrowserPeer,
} from '../src/browser-terminal-relay.js';
import { TerminalAdmissionError, type TerminalAdmissionStore } from '../src/terminal-admission-store.js';
import { TerminalClientError, type TerminalClientEnd } from '../src/terminal-client.js';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ticket = 'a'.repeat(43);
const allowedOrigin = 'https://app.opsreplay.test';

const unusedAdmissions: TerminalAdmissionStore = {
  admit: async () => {
    throw new Error('Unexpected admission call.');
  },
  authorizeInput: async () => {
    throw new Error('Unexpected authorization call.');
  },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Condition was not met before the test deadline.'));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

class ClientInbox {
  private readonly queued: { data: Buffer; binary: boolean }[] = [];
  private readonly waiting: ((value: { data: Buffer; binary: boolean }) => void)[] = [];

  constructor(socket: WebSocket) {
    socket.on('message', (data, binary) => {
      const message = { data: rawBuffer(data), binary };
      const waiter = this.waiting.shift();
      if (waiter === undefined) this.queued.push(message);
      else waiter(message);
    });
  }

  async next(): Promise<{ data: Buffer; binary: boolean }> {
    const queued = this.queued.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async json(): Promise<Record<string, unknown>> {
    const message = await this.next();
    assert.equal(message.binary, false);
    return JSON.parse(message.data.toString('utf8')) as Record<string, unknown>;
  }
}

function openClient(url: string, origin = allowedOrigin): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function closeClient(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

function socketClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
}

interface SessionFixture {
  opener: BrowserTerminalSessionOpener;
  calls: string[];
  outputs: ((data: Buffer) => void | Promise<void>)[];
  options: { sessionId: string; ticket: string; columns: number; rows: number }[];
  terminalEnds: Deferred<TerminalClientEnd>[];
}

function sessionFixture(replayTruncated = false): SessionFixture {
  const calls: string[] = [];
  const outputs: ((data: Buffer) => void | Promise<void>)[] = [];
  const options: SessionFixture['options'] = [];
  const terminalEnds: Deferred<TerminalClientEnd>[] = [];
  const opener: BrowserTerminalSessionOpener = async (value) => {
    options.push({
      sessionId: value.sessionId,
      ticket: value.ticket,
      columns: value.columns,
      rows: value.rows,
    });
    outputs.push(value.onOutput);
    const terminalEnd = deferred<TerminalClientEnd>();
    terminalEnds.push(terminalEnd);
    const session: BrowserTerminalSession = {
      sessionId: value.sessionId,
      generation: 3,
      ended: terminalEnd.promise,
      input: async (data) => {
        calls.push(`input:${Buffer.from(data).toString('utf8')}`);
      },
      resize: async (columns, rows) => {
        calls.push(`resize:${columns}x${rows}`);
      },
      heartbeat: async () => {
        calls.push('heartbeat');
      },
      close: () => {
        calls.push('close');
      },
    };
    return {
      session,
      ready: {
        sessionId: value.sessionId,
        generation: 3,
        resumed: true,
        replayTruncated,
      },
    };
  };
  return { opener, calls, outputs, options, terminalEnds };
}

async function relayFixture(
  opener: BrowserTerminalSessionOpener,
  overrides: {
    authTimeoutMs?: number;
    sendTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    maxConnections?: number;
    maxPendingAuthentications?: number;
  } = {},
): Promise<{ server: Server; relay: GatewayBrowserTerminalRelay; url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const relay = new GatewayBrowserTerminalRelay(
    server,
    {
      allowedOrigins: [allowedOrigin],
      admissions: unusedAdmissions,
      maxConnections: 8,
      maxPendingAuthentications: 4,
      ...overrides,
    },
    { openSession: opener },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    server,
    relay,
    url: `ws://127.0.0.1:${address.port}/v1/terminal`,
    close: async () => {
      await relay.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function rejectedUpgradeStatus(url: string, origin: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin === undefined ? {} : { origin });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    socket.once('error', (error) => {
      if ((error as Error & { code?: string }).code !== 'ECONNRESET') reject(error);
    });
  });
}

function resetRejectedUpgrade(url: string): Promise<void> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(parsed.port), parsed.hostname);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined || ['ECONNRESET', 'EPIPE'].includes((error as Error & { code?: string }).code ?? '')) {
        resolve();
      } else {
        reject(error);
      }
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error('Rejected upgrade socket did not close.'));
    }, 1_000);
    socket.once('connect', () => {
      socket.resume();
      socket.write(
        `GET ${parsed.pathname} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Origin: https://evil.example\r\n\r\n',
      );
      setImmediate(() => socket.resetAndDestroy());
    });
    socket.once('error', finish);
    socket.once('close', () => finish());
  });
}

function openHalfClosedRejectedUpgrade(url: string): Promise<ReturnType<typeof connect>> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port), allowHalfOpen: true });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined || (error as Error & { code?: string }).code === 'ECONNRESET') resolve(socket);
      else reject(error);
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error('Rejected upgrade did not finish its response.'));
    }, 1_000);
    socket.once('connect', () => {
      socket.resume();
      socket.write(
        `GET ${parsed.pathname} HTTP/1.1\r\n` +
          `Host: ${parsed.host}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Origin: https://evil.example\r\n\r\n',
      );
    });
    socket.once('end', () => finish());
    socket.once('close', () => finish());
    socket.once('error', finish);
  });
}

test('relays authenticated browser input, control messages, output, and replay state', async (t) => {
  const f = sessionFixture(true);
  const runtime = await relayFixture(f.opener);
  t.after(() => runtime.close());
  const socket = await openClient(runtime.url);
  t.after(() => closeClient(socket));
  const inbox = new ClientInbox(socket);

  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
  assert.deepEqual(await inbox.json(), {
    type: 'ready',
    sessionId,
    status: 'ready',
    resumed: true,
    replayTruncated: true,
  });
  assert.deepEqual(f.options, [{ sessionId, ticket, columns: 80, rows: 24 }]);

  const output = f.outputs[0]?.(Buffer.from('terminal output\r\n'));
  assert.ok(output);
  await output;
  const browserOutput = await inbox.next();
  assert.equal(browserOutput.binary, true);
  assert.equal(browserOutput.data.toString('utf8'), 'terminal output\r\n');

  socket.send(Buffer.from('whoami\n'));
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 32 }));
  socket.send(JSON.stringify({ type: 'heartbeat' }));
  socket.send(JSON.stringify({ type: 'run_proposal', proposalId: '77777777-7777-4777-8777-777777777777' }));

  assert.deepEqual(await inbox.json(), {
    type: 'error',
    code: 'PROPOSAL_UNAVAILABLE',
    message: 'Proposal execution is not available.',
  });
  await waitFor(() => f.calls.length >= 2);
  assert.deepEqual(f.calls, ['input:whoami\n', 'resize:120x32']);
  assert.equal(socket.readyState, WebSocket.OPEN);

  await closeClient(socket);
  await waitFor(() => f.calls.includes('close'));
});

test('rejects a missing or untrusted browser origin before opening a session', async (t) => {
  const f = sessionFixture();
  const runtime = await relayFixture(f.opener);
  t.after(() => runtime.close());

  for (const origin of [undefined, 'https://evil.example']) {
    const status = await rejectedUpgradeStatus(runtime.url, origin);
    assert.equal(status, 403);
  }
  assert.equal(f.options.length, 0);
});

test('destroys rejected upgrade sockets and survives connection resets', async (t) => {
  const f = sessionFixture();
  const runtime = await relayFixture(f.opener);
  t.after(() => runtime.close());

  const halfClosed = await openHalfClosedRejectedUpgrade(runtime.url);
  t.after(() => halfClosed.destroy());
  await Promise.all(Array.from({ length: 50 }, () => resetRejectedUpgrade(runtime.url)));
  await delay(25);
  const openConnections = await new Promise<number>((resolve, reject) => {
    runtime.server.getConnections((error, count) => (error === null ? resolve(count) : reject(error)));
  });
  assert.equal(openConnections, 0);

  const socket = await openClient(runtime.url);
  const inbox = new ClientInbox(socket);
  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
  assert.equal((await inbox.json()).type, 'ready');
  await closeClient(socket);
});

test('bounds total and pending terminal connections before admission', async (t) => {
  const f = sessionFixture();
  const runtime = await relayFixture(f.opener, { maxConnections: 2, maxPendingAuthentications: 1 });
  t.after(() => runtime.close());

  const pending = await openClient(runtime.url);
  assert.equal(await rejectedUpgradeStatus(runtime.url, allowedOrigin), 503);

  const inbox = new ClientInbox(pending);
  pending.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
  assert.equal((await inbox.json()).type, 'ready');
  await delay(0);

  const second = await openClient(runtime.url);
  assert.equal(await rejectedUpgradeStatus(runtime.url, allowedOrigin), 503);

  await closeClient(second);
  await closeClient(pending);
});

test('rejects another path and URL query before the WebSocket upgrade', async (t) => {
  const f = sessionFixture();
  const runtime = await relayFixture(f.opener);
  t.after(() => runtime.close());

  for (const url of [runtime.url.replace('/v1/terminal', '/other'), `${runtime.url}?ticket=must-not-be-in-url`]) {
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(url, { origin: allowedOrigin });
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      socket.once('error', reject);
    });
    assert.equal(status, 404);
  }
  assert.equal(f.options.length, 0);
});

test('requires one valid auth text frame before the deadline', async (t) => {
  const f = sessionFixture();
  const runtime = await relayFixture(f.opener, { authTimeoutMs: 25 });
  t.after(() => runtime.close());

  const idle = await openClient(runtime.url);
  const idleInbox = new ClientInbox(idle);
  const idleClosed = socketClose(idle);
  assert.deepEqual(await idleInbox.json(), {
    type: 'error',
    code: 'AUTH_FAILED',
    message: 'Terminal authentication failed.',
  });
  assert.deepEqual(await idleClosed, { code: 1008, reason: 'AUTH_FAILED' });

  const binary = await openClient(runtime.url);
  const binaryInbox = new ClientInbox(binary);
  const binaryClosed = socketClose(binary);
  binary.send(Buffer.from('not-auth'));
  assert.equal((await binaryInbox.json()).code, 'AUTH_FAILED');
  assert.equal((await binaryClosed).code, 1008);
  assert.equal(f.options.length, 0);
});

test('maps admission failures to bounded public errors', async (t) => {
  for (const [privateCode, publicCode, message] of [
    ['auth_failed', 'AUTH_FAILED', 'Terminal authentication failed.'],
    ['ticket_expired', 'TICKET_EXPIRED', 'The terminal ticket expired.'],
    ['session_not_ready', 'SESSION_NOT_READY', 'The terminal session is not ready.'],
    ['session_terminal', 'SESSION_TERMINAL', 'The terminal session has ended.'],
    ['unavailable', 'INTERNAL_ERROR', 'The terminal connection failed.'],
  ] as const) {
    const runtime = await relayFixture(async () => {
      throw new TerminalAdmissionError(privateCode);
    });
    t.after(() => runtime.close());
    const socket = await openClient(runtime.url);
    const inbox = new ClientInbox(socket);
    const closed = socketClose(socket);
    socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
    const error = await inbox.json();
    assert.equal(error.code, publicCode);
    assert.equal(error.message, message);
    assert.equal((await closed).code, publicCode === 'INTERNAL_ERROR' ? 1011 : 1008);
  }
});

test('closes a replaced connection without forwarding later queued input', async (t) => {
  let privateCalls = 0;
  const base = sessionFixture();
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    const opened = await base.opener(options, signal);
    opened.session.input = async () => {
      privateCalls++;
      throw new TerminalAdmissionError('replaced');
    };
    opened.session.resize = async () => {
      privateCalls++;
    };
    opened.session.close = () => base.calls.push('close');
    return opened;
  };
  const runtime = await relayFixture(opener);
  t.after(() => runtime.close());
  const socket = await openClient(runtime.url);
  const inbox = new ClientInbox(socket);
  const closed = socketClose(socket);
  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await inbox.json();
  socket.send(Buffer.from('old input'));
  socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));

  assert.equal((await inbox.json()).code, 'REPLACED');
  assert.equal((await closed).code, 1008);
  assert.equal(privateCalls, 1);
  assert.deepEqual(base.calls, ['close']);
});

class FakePeer implements GatewayBrowserPeer {
  open = true;
  paused = false;
  terminated = false;
  readonly sent: { data: string | Buffer; binary: boolean }[] = [];
  readonly sendCallbacks: ((error?: Error | null) => void)[] = [];
  pings = 0;
  private messageListener: ((data: Buffer, binary: boolean) => void) | undefined;
  private closeListener: (() => void) | undefined;
  private errorListener: (() => void) | undefined;

  isOpen(): boolean {
    return this.open;
  }

  send(data: string | Buffer, binary: boolean, callback: (error?: Error | null) => void): void {
    this.sent.push({ data, binary });
    this.sendCallbacks.push(callback);
  }

  ping(callback: (error?: Error | null) => void): void {
    this.pings++;
    callback();
  }

  close(): void {
    this.open = false;
    this.closeListener?.();
  }

  terminate(): void {
    this.open = false;
    this.terminated = true;
    this.closeListener?.();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void {
    this.messageListener = listener;
    return () => {
      this.messageListener = undefined;
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => {
      this.closeListener = undefined;
    };
  }

  onError(listener: () => void): () => void {
    this.errorListener = listener;
    return () => {
      this.errorListener = undefined;
    };
  }

  error(): void {
    this.errorListener?.();
  }

  message(data: string | Buffer, binary = false): void {
    this.messageListener?.(Buffer.isBuffer(data) ? data : Buffer.from(data), binary);
  }

  completeSend(index: number): void {
    this.sendCallbacks[index]?.();
  }
}

test('stops the private terminal when one browser output send exceeds its deadline', async () => {
  const peer = new FakePeer();
  const f = sessionFixture();
  const connection = new GatewayBrowserTerminalConnection(peer, {
    openSession: f.opener,
    authTimeoutMs: 100,
    sendTimeoutMs: 20,
  });
  peer.message(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => peer.sent.length === 1);
  peer.completeSend(0);
  await waitFor(() => f.outputs.length === 1);

  const delivery = f.outputs[0]?.(Buffer.alloc(8 * 1024, 1));
  assert.ok(delivery);
  await assert.rejects(delivery, (error: unknown) => error instanceof Error && error.name === 'BrowserSendError');
  await connection.closed;

  assert.equal(peer.sent.length, 2);
  assert.equal(peer.sent[1]?.binary, true);
  assert.equal(peer.terminated, true);
  assert.ok(f.calls.includes('close'));
});

test('rejects oversized output before it reaches the browser send queue', async () => {
  const peer = new FakePeer();
  const f = sessionFixture();
  const connection = new GatewayBrowserTerminalConnection(peer, {
    openSession: f.opener,
    authTimeoutMs: 100,
    sendTimeoutMs: 20,
  });
  peer.message(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => peer.sent.length === 1);
  peer.completeSend(0);
  await waitFor(() => f.outputs.length === 1);

  const delivery = f.outputs[0]?.(Buffer.alloc(8 * 1024 + 1));
  assert.ok(delivery);
  await assert.rejects(delivery);
  await connection.closed;

  assert.equal(peer.sent.length, 1);
  assert.equal(peer.terminated, true);
  assert.ok(f.calls.includes('close'));
});

test('keeps both idle relay legs alive without a browser timer', async () => {
  const peer = new FakePeer();
  const f = sessionFixture();
  const connection = new GatewayBrowserTerminalConnection(peer, {
    openSession: f.opener,
    authTimeoutMs: 100,
    sendTimeoutMs: 100,
    heartbeatIntervalMs: 20,
  });
  peer.message(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => peer.sent.length === 1);
  peer.completeSend(0);

  await waitFor(() => peer.pings === 1);
  assert.ok(f.calls.includes('heartbeat'));

  connection.shutdown();
  await connection.closed;
});

test('coalesces queued browser input while one private operation is blocked', async () => {
  const peer = new FakePeer();
  const releaseInput = deferred<void>();
  const base = sessionFixture();
  const inputs: string[] = [];
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    const opened = await base.opener(options, signal);
    opened.session.input = async (data) => {
      inputs.push(Buffer.from(data).toString('utf8'));
      if (inputs.length === 1) await releaseInput.promise;
    };
    return opened;
  };
  const connection = new GatewayBrowserTerminalConnection(peer, {
    openSession: opener,
    authTimeoutMs: 100,
    sendTimeoutMs: 100,
  });
  peer.message(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => peer.sent.length === 1);
  peer.completeSend(0);
  await delay(0);

  peer.message(Buffer.from('a'), true);
  await waitFor(() => inputs.length === 1);
  for (let index = 0; index < 65; index++) peer.message(Buffer.from('b'), true);
  assert.equal(peer.sent.length, 1);
  releaseInput.resolve();
  await waitFor(() => inputs.length === 2);

  assert.deepEqual(inputs, ['a', 'b'.repeat(65)]);
  connection.shutdown();
  await connection.closed;
});

test('keeps a message-count backstop for queued browser controls', async () => {
  const peer = new FakePeer();
  const releaseInput = deferred<void>();
  const base = sessionFixture();
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    const opened = await base.opener(options, signal);
    opened.session.input = async () => releaseInput.promise;
    return opened;
  };
  const connection = new GatewayBrowserTerminalConnection(peer, {
    openSession: opener,
    authTimeoutMs: 100,
    sendTimeoutMs: 100,
  });
  peer.message(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => peer.sent.length === 1);
  peer.completeSend(0);
  await delay(0);

  peer.message(Buffer.from('a'), true);
  for (let index = 0; index < 65; index++) {
    peer.message(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  }
  await waitFor(() => peer.sent.length === 2);
  assert.deepEqual(JSON.parse(String(peer.sent[1]?.data)), {
    type: 'error',
    code: 'RATE_LIMITED',
    message: 'Terminal input is arriving too quickly.',
  });
  peer.completeSend(1);
  releaseInput.resolve();
  await connection.closed;

  assert.equal(peer.paused, false);
  assert.ok(base.calls.includes('close'));
});

test('keeps a byte backstop for coalesced browser input', async () => {
  const peer = new FakePeer();
  const releaseInput = deferred<void>();
  const base = sessionFixture();
  let inputCalls = 0;
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    const opened = await base.opener(options, signal);
    opened.session.input = async () => {
      inputCalls++;
      await releaseInput.promise;
    };
    return opened;
  };
  const connection = new GatewayBrowserTerminalConnection(peer, {
    openSession: opener,
    authTimeoutMs: 100,
    sendTimeoutMs: 100,
  });
  peer.message(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => peer.sent.length === 1);
  peer.completeSend(0);
  await delay(0);

  peer.message(Buffer.from('a'), true);
  await waitFor(() => inputCalls === 1);
  for (let index = 0; index < 4; index++) peer.message(Buffer.alloc(16 * 1024, index), true);
  await waitFor(() => peer.sent.length === 2);
  assert.equal(JSON.parse(String(peer.sent[1]?.data)).code, 'RATE_LIMITED');
  peer.completeSend(1);
  releaseInput.resolve();
  await connection.closed;

  assert.equal(inputCalls, 1);
  assert.ok(base.calls.includes('close'));
});

test('returns an uncertain terminal input failure once and does not retry it', async (t) => {
  let inputs = 0;
  const base = sessionFixture();
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    const opened = await base.opener(options, signal);
    opened.session.input = async () => {
      inputs++;
      throw new TerminalClientError('input_uncertain');
    };
    return opened;
  };
  const runtime = await relayFixture(opener);
  t.after(() => runtime.close());
  const socket = await openClient(runtime.url);
  const inbox = new ClientInbox(socket);
  const closed = socketClose(socket);
  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await inbox.json();
  socket.send(Buffer.from('possibly accepted'));

  assert.equal((await inbox.json()).code, 'INTERNAL_ERROR');
  assert.equal((await closed).code, 1011);
  assert.equal(inputs, 1);
});

test('does not expose a ready state before the private session attaches', async (t) => {
  const release = deferred<void>();
  const f = sessionFixture();
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    await release.promise;
    return f.opener(options, signal);
  };
  const runtime = await relayFixture(opener);
  t.after(() => runtime.close());
  const socket = await openClient(runtime.url);
  const inbox = new ClientInbox(socket);
  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));

  let receivedBeforeAttach = false;
  const observe = () => {
    receivedBeforeAttach = true;
  };
  socket.on('message', observe);
  await delay(25);
  socket.off('message', observe);
  assert.equal(receivedBeforeAttach, false);
  release.resolve();
  assert.equal((await inbox.json()).type, 'ready');
});

test('sends public readiness before replayed private terminal output', async (t) => {
  const base = sessionFixture();
  let outputDelivery: Promise<void> | undefined;
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    const opened = await base.opener(options, signal);
    outputDelivery = Promise.resolve(options.onOutput(Buffer.from('replayed output')));
    return opened;
  };
  const runtime = await relayFixture(opener);
  t.after(() => runtime.close());
  const socket = await openClient(runtime.url);
  t.after(() => closeClient(socket));
  const inbox = new ClientInbox(socket);
  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));

  assert.equal((await inbox.json()).type, 'ready');
  const output = await inbox.next();
  assert.equal(output.binary, true);
  assert.equal(output.data.toString('utf8'), 'replayed output');
  assert.ok(outputDelivery);
  await outputDelivery;
});

test('closes a private session that attaches after the browser disconnects', async (t) => {
  const releaseAttach = deferred<void>();
  const base = sessionFixture();
  let admissionSignal: AbortSignal | undefined;
  const opener: BrowserTerminalSessionOpener = async (options, signal) => {
    admissionSignal = signal;
    await releaseAttach.promise;
    return base.opener(options, signal);
  };
  const runtime = await relayFixture(opener);
  t.after(() => runtime.close());
  const socket = await openClient(runtime.url);
  socket.send(JSON.stringify({ type: 'auth', sessionId, ticket }));
  await waitFor(() => admissionSignal !== undefined);

  await closeClient(socket);
  await waitFor(() => admissionSignal?.aborted === true);
  const relayClosing = runtime.relay.close();
  assert.equal(await Promise.race([relayClosing.then(() => true), delay(10).then(() => false)]), false);
  releaseAttach.resolve();
  await relayClosing;
  await waitFor(() => base.calls.includes('close'));
  assert.equal(base.calls.filter((call) => call === 'close').length, 1);
});
