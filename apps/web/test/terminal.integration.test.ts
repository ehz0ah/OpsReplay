import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClient } from '../src/api.js';
import {
  TerminalAttachment,
  terminalUrl,
  type TerminalSocket,
  type AttachmentState,
} from '../src/terminal/attachment.js';
const id = '11111111-1111-4111-8111-111111111111';
class Socket implements TerminalSocket {
  binaryType = '';
  readyState = 1;
  bufferedAmount = 0;
  onopen: TerminalSocket['onopen'] = null;
  onclose: TerminalSocket['onclose'] = null;
  onerror: TerminalSocket['onerror'] = null;
  onmessage: TerminalSocket['onmessage'] = null;
  sent: (string | ArrayBufferView)[] = [];
  send(value: string | ArrayBufferView) {
    this.sent.push(
      typeof value === 'string' ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice(),
    );
  }
  close() {
    this.readyState = 3;
  }
  frame(data: unknown) {
    this.onmessage?.({
      data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data),
    } as MessageEvent);
  }
  admitted(resumed = false, replayTruncated = false) {
    this.onopen?.({} as Event);
    this.frame({ type: 'ready', sessionId: id, status: 'ready', resumed, replayTruncated });
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected asynchronous state was not reached');
}
function fixture(
  options: {
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
    failure?: boolean;
    output?: (bytes: Uint8Array) => Promise<void>;
  } = {},
) {
  const sockets: Socket[] = [],
    states: { state: AttachmentState; message: string | null }[] = [],
    output: number[][] = [];
  let tickets = 0;
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (_url, request) => {
      assert.equal(request?.method, 'POST');
      assert.equal(request?.body, undefined);
      assert.equal(new Headers(request?.headers).get('Content-Type'), null);
      tickets++;
      if (options.failure && tickets === 1)
        return new Response(
          JSON.stringify({ code: 'LIMIT_EXCEEDED', message: 'Wait', requestId: id, retryAfterSeconds: 7 }),
          { status: 429 },
        );
      return new Response(
        JSON.stringify({
          sessionId: id,
          ticket: 'a'.repeat(64),
          url: 'wss://example.com/v1/terminal',
          expiresAt: '2026-10-17T00:00:00Z',
        }),
      );
    },
  );
  const attachment = new TerminalAttachment(
    api,
    id,
    {
      state: (state, message) => states.push({ state, message }),
      output: async (bytes) => {
        output.push([...bytes]);
        await options.output?.(bytes);
      },
      frame: () => {},
      refresh: () => {},
    },
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    true,
    options.wait,
  );
  return { attachment, sockets, states, output, tickets: () => tickets };
}
test('empty POST gets one-use tickets; admission preserves binary bytes, bounded input, and resize', async () => {
  const f = fixture();
  const run = f.attachment.start();
  try {
    await until(() => f.sockets.length === 1);
    const socket = f.sockets[0]!;
    assert.equal(f.attachment.input('no'), false);
    socket.admitted(true, true);
    await until(() => f.states.some((value) => value.state === 'ready'));
    assert.match(f.states.at(-1)!.message!, /continuity is incomplete/);
    assert.deepEqual(JSON.parse(socket.sent[0] as string), { type: 'auth', sessionId: id, ticket: 'a'.repeat(64) });
    assert.equal(f.attachment.input('é'), true);
    assert.equal(f.attachment.binary('\u00ff\u0080'), true);
    assert.deepEqual([...(socket.sent[1] as Uint8Array)], [195, 169]);
    assert.deepEqual([...(socket.sent[2] as Uint8Array)], [255, 128]);
    const count = socket.sent.length;
    assert.equal(f.attachment.input('a'.repeat(65537)), false);
    assert.equal(socket.sent.length, count);
    f.attachment.resize(NaN, 24);
    assert.equal(socket.sent.length, count);
    f.attachment.resize(1, 1000);
    assert.deepEqual(JSON.parse(socket.sent.at(-1) as string), { type: 'resize', cols: 20, rows: 200 });
    socket.frame(new Uint8Array([0, 255, 27]).buffer);
    await until(() => f.output.length === 1);
    assert.deepEqual(f.output, [[0, 255, 27]]);
  } finally {
    f.attachment.stop();
    await run;
  }
});
test('reconnect gets a fresh ticket, retains the screen, and never resends old input', async () => {
  const f = fixture({ wait: async () => {} });
  const run = f.attachment.start();
  try {
    await until(() => f.sockets.length === 1);
    f.sockets[0]!.admitted();
    await until(() => f.states.at(-1)?.state === 'ready');
    f.attachment.input('echo once\r');
    f.sockets[0]!.onclose?.({ code: 1006 } as CloseEvent);
    await until(() => f.sockets.length === 2);
    f.sockets[1]!.admitted(true);
    await until(() => f.states.at(-1)?.state === 'ready');
    assert.equal(f.tickets(), 2);
    assert.equal(f.states.at(-1)?.message, null);
    assert.equal(f.sockets[1]!.sent.length, 1);
  } finally {
    f.attachment.stop();
    await run;
  }
});
test('replacement drains the queued error before close and never starts a reconnect fight', async () => {
  const f = fixture({ wait: async () => {} });
  const run = f.attachment.start();
  await until(() => f.sockets.length === 1);
  const socket = f.sockets[0]!;
  socket.admitted();
  await until(() => f.states.at(-1)?.state === 'ready');
  socket.frame({ type: 'error', code: 'REPLACED', message: 'Replaced' });
  socket.onclose?.({ code: 1008 } as CloseEvent);
  await run;
  assert.equal(f.states.at(-1)?.state, 'replaced');
  assert.equal(f.tickets(), 1);
});
test('policy close without an error frame needs explicit reopening', async () => {
  const f = fixture();
  const run = f.attachment.start();
  await until(() => f.sockets.length === 1);
  f.sockets[0]!.onclose?.({ code: 1008 } as CloseEvent);
  await run;
  assert.equal(f.states.at(-1)?.state, 'closed');
  assert.equal(f.tickets(), 1);
});
test('ticket throttling respects the server retry delay and cancellation prevents more calls', async () => {
  let delay = 0;
  const f = fixture({
    failure: true,
    wait: async (ms) => {
      delay = ms;
      f.attachment.stop();
    },
  });
  await f.attachment.start();
  assert.ok(delay >= 7000);
  assert.equal(f.tickets(), 1);
  assert.equal(f.sockets.length, 0);
});
test('invalid and oversized frames fail closed and endpoint validation excludes credentials and query', async () => {
  for (const data of [
    { type: 'ready', sessionId: id, status: 'ready', resumed: false, replayTruncated: false, hidden: 'root' },
    'x'.repeat(16385),
  ]) {
    const f = fixture();
    const run = f.attachment.start();
    await until(() => f.sockets.length === 1);
    f.sockets[0]!.frame(data);
    await run;
    assert.equal(f.states.at(-1)?.state, 'error');
    assert.equal(f.tickets(), 1);
  }
  for (const url of [
    'wss://user:pass@example/v1/terminal',
    'wss://example/v1/terminal?ticket=x',
    'ws://example/v1/terminal',
    'wss://example/other',
  ])
    assert.throws(() => terminalUrl(url, true));
});

test('a delayed output failure on a detached socket cannot overwrite its replacement', async () => {
  let rejectOutput!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => {
    rejectOutput = reject;
  });
  const f = fixture({ wait: async () => {}, output: async () => pending });
  const run = f.attachment.start();
  try {
    await until(() => f.sockets.length === 1);
    f.sockets[0]!.admitted();
    await until(() => f.states.at(-1)?.state === 'ready');
    f.sockets[0]!.frame(new Uint8Array([1]).buffer);
    await until(() => f.output.length === 1);
    f.sockets[0]!.onerror?.({} as Event);
    await until(() => f.sockets.length === 2);
    f.sockets[1]!.admitted(true);
    await until(() => f.states.at(-1)?.state === 'ready');
    rejectOutput(new Error('old output timeout'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.states.at(-1)?.state, 'ready');
    assert.equal(f.attachment.input('new input'), true);
  } finally {
    f.attachment.stop();
    await run;
  }
});
