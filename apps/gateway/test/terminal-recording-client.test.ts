import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, Socket } from 'node:net';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  TerminalRecordingClient,
  TerminalRecordingClientError,
  type TerminalRecordingClientOptions,
} from '../src/terminal-recording-client.js';
import {
  terminalRecordingSchema,
  type TerminalRecordingEvent,
  type TerminalRecordingPage,
  type TerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.js';

const source = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherSource = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const time = (ms: number) => new Date(Date.UTC(2026, 9, 11) + ms).toISOString();
const ready = (changes: Partial<TerminalRecordingReady> = {}): TerminalRecordingReady => ({
  type: 'recording_ready',
  version: 1,
  source,
  startedAt: time(0),
  initialColumns: 80,
  initialRows: 24,
  latestSequence: 1,
  observedAt: time(10),
  shellState: 'running',
  loss: null,
  ...changes,
});
const dimensions = (sequence = 1, ms = 1): TerminalRecordingEvent => ({
  sequence,
  recordedAt: time(ms),
  type: 'dimensions',
  columns: 80,
  rows: 24,
});
const output = (sequence: number, ms: number): TerminalRecordingEvent => ({
  sequence,
  recordedAt: time(ms),
  type: 'output',
  data: Buffer.from('bytes\0\xff', 'latin1').toString('base64'),
});
const page = (
  events: TerminalRecordingEvent[],
  changes: Partial<TerminalRecordingPage> = {},
): TerminalRecordingPage => ({
  ...ready(),
  type: 'recording_page',
  events,
  nextSequence: events.at(-1)?.sequence ?? 1,
  ...changes,
});
const errorCode = (code: TerminalRecordingClientError['code']) => (error: unknown) =>
  error instanceof TerminalRecordingClientError && error.code === code && error.cause === undefined;

class Peer {
  private buffer = '';
  private frames: Record<string, unknown>[] = [];
  private notify: (() => void) | undefined;
  readonly closed: Promise<void>;

  constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => socket.once('close', resolve));
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        this.frames.push(JSON.parse(this.buffer.slice(0, end)) as Record<string, unknown>);
        this.buffer = this.buffer.slice(end + 1);
      }
      this.notify?.();
    });
  }

  async receive(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 2_000;
    while (this.frames.length === 0) {
      assert.ok(Date.now() < deadline, 'client request timed out');
      await Promise.race([
        new Promise<void>((resolve) => {
          this.notify = resolve;
        }),
        delay(10),
      ]);
      this.notify = undefined;
    }
    return this.frames.shift()!;
  }

  send(value: unknown): void {
    this.socket.write(JSON.stringify(value) + '\n');
  }
  get waiting(): number {
    return this.frames.length + this.buffer.length;
  }
}

async function fixture(t: TestContext) {
  const peers: Peer[] = [];
  let notify: (() => void) | undefined;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    peers.push(new Peer(socket));
    notify?.();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return {
    options: { host: '127.0.0.1', port: address.port, connectTimeoutMs: 1_000, requestTimeoutMs: 1_000 },
    async accept() {
      while (peers.length === 0)
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      notify = undefined;
      return peers.shift()!;
    },
  };
}

async function opening(t: TestContext, overrides: Partial<TerminalRecordingClientOptions> = {}) {
  const setup = await fixture(t);
  const connecting = TerminalRecordingClient.connect({ ...setup.options, ...overrides });
  const peer = await setup.accept();
  assert.deepEqual(await peer.receive(), { type: 'attach', version: 1, mode: 'recording' });
  return { ...setup, peer, connecting };
}

async function connected(t: TestContext, initial = ready(), overrides: Partial<TerminalRecordingClientOptions> = {}) {
  const setup = await opening(t, overrides);
  setup.peer.send(initial);
  const result = await setup.connecting;
  t.after(() => result.client.close());
  return { ...setup, ...result };
}

async function respond(client: TerminalRecordingClient, peer: Peer, after: number, response: unknown) {
  const reading = client.read(after);
  assert.deepEqual(await peer.receive(), { type: 'read', source, after });
  peer.send(response);
  return reading;
}

async function rejectedRead(client: TerminalRecordingClient, peer: Peer, after: number, response: unknown) {
  const reading = client.read(after);
  const rejection = assert.rejects(reading, errorCode('invalid_response'));
  await peer.receive();
  peer.send(response);
  await rejection;
  await peer.closed;
  const end = await client.ended;
  assert.equal(end.reason, 'error');
  if (end.reason === 'error') assert.equal(end.error.code, 'invalid_response');
}

test('reads all event types with explicit cursors, immutable caller results, and nondestructive replay', async (t) => {
  const setup = await opening(t);
  const encoded = Buffer.from(JSON.stringify(ready({ latestSequence: 4 })) + '\n');
  for (const byte of encoded) {
    setup.peer.socket.write(Buffer.from([byte]));
    await delay(1);
  }
  const { client, ready: attached } = await setup.connecting;
  t.after(() => client.close());
  attached.source = otherSource;
  attached.startedAt = time(999);
  const events: TerminalRecordingEvent[] = [
    dimensions(),
    { sequence: 2, recordedAt: time(2), type: 'input', data: 'eAo=' },
    output(3, 3),
    { sequence: 4, recordedAt: time(4), type: 'dimensions', columns: 120, rows: 40 },
  ];
  const response = page(events, { latestSequence: 4 });
  const first = await respond(client, setup.peer, 0, response);
  assert.deepEqual(first, response);
  first.events[3]!.recordedAt = time(999);
  (first.events[3] as { columns: number }).columns = 500;
  first.source = otherSource;
  assert.deepEqual(await respond(client, setup.peer, 0, response), response);
  assert.equal(
    (await respond(client, setup.peer, 4, page([], { latestSequence: 4, nextSequence: 4 }))).nextSequence,
    4,
  );
  client.close();
  client.close();
  assert.deepEqual(await client.ended, { reason: 'closed' });
  await assert.rejects(client.read(0), errorCode('closed'));
});

test('rejects invalid configuration and already-cancelled connect before any socket', async () => {
  for (const changes of [
    { host: 'example.com' },
    { host: 1 },
    { port: 0 },
    { port: 65_536 },
    { connectTimeoutMs: 0 },
    { requestTimeoutMs: 60_001 },
    { requestTimeoutMs: NaN },
    { expectedSource: otherSource.toUpperCase() },
  ]) {
    await assert.rejects(
      TerminalRecordingClient.connect({ host: '127.0.0.1', ...changes } as TerminalRecordingClientOptions),
      errorCode('invalid_config'),
    );
  }
  await assert.rejects(
    TerminalRecordingClient.connect({ host: '127.0.0.1' }, AbortSignal.abort()),
    errorCode('cancelled'),
  );
});

test('rejects bad cursors, cancellation before send, and concurrent reads without closing or queuing', async (t) => {
  const { client, peer } = await connected(t);
  for (const cursor of [-1, 1.5, NaN, Infinity, 100_001])
    await assert.rejects(client.read(cursor), errorCode('invalid_request'));
  await assert.rejects(client.read(0, AbortSignal.abort()), errorCode('cancelled'));
  const reading = client.read(0);
  await peer.receive();
  for (let i = 0; i < 100; i++) await assert.rejects(client.read(0), errorCode('busy'));
  await delay(20);
  assert.equal(peer.waiting, 0);
  peer.send(page([dimensions()]));
  await reading;
  assert.deepEqual(await respond(client, peer, 0, page([dimensions()])), page([dimensions()]));
});

test('pins expected source on attach and permits same-source explicit reconnect', async (t) => {
  const { client, peer, options, accept } = await connected(t, ready(), { expectedSource: source });
  const first = await respond(client, peer, 0, page([dimensions()]));
  client.close();
  const reconnecting = TerminalRecordingClient.connect({ ...options, expectedSource: source });
  const secondPeer = await accept();
  await secondPeer.receive();
  secondPeer.send(ready());
  const resumed = await reconnecting;
  assert.deepEqual(await respond(resumed.client, secondPeer, first.nextSequence, page([])), page([]));
  resumed.client.close();
  const wrong = await opening(t, { expectedSource: otherSource });
  const rejection = assert.rejects(wrong.connecting, errorCode('invalid_response'));
  wrong.peer.send(ready());
  await rejection;
  await wrong.peer.closed;
});

test('checks exact response byte cap including newline and rejects padding overflow', async (t) => {
  for (const extra of [0, 1])
    await t.test(String(extra), async (t) => {
      const { connecting, peer } = await opening(t);
      const raw = JSON.stringify(ready());
      const bytes = Buffer.from(
        raw + ' '.repeat(terminalRecordingSchema.maximumResponseBytes - Buffer.byteLength(raw) - 1 + extra) + '\n',
      );
      if (extra) {
        const rejection = assert.rejects(connecting, errorCode('invalid_response'));
        peer.socket.write(bytes.subarray(0, bytes.length - 1));
        await rejection;
      } else {
        peer.socket.write(bytes.subarray(0, bytes.length - 1));
        await delay(5);
        peer.socket.write(bytes.subarray(-1));
        const { client } = await connecting;
        client.close();
      }
    });
});

test('rejects malformed wire data, duplicate decoded keys, excessive depth, and unexpected frames', async (t) => {
  const raw = JSON.stringify(ready());
  const invalid: Array<[string, Buffer]> = [
    ['empty', Buffer.from('\n')],
    ['syntax', Buffer.from('{\n')],
    ['UTF-8', Buffer.from([0xc3, 0x28, 10])],
    ['BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw + '\n')])],
    ['duplicate', Buffer.from(raw.replace('"version":1', '"version":2,"version":1') + '\n')],
    ['escaped duplicate', Buffer.from(raw.replace('"version":1', '"\\u0076ersion":2,"version":1') + '\n')],
    [
      'nested duplicate',
      Buffer.from(
        JSON.stringify(ready({ loss: { reason: 'data_gap', occurredAt: time(5) } })).replace(
          '"reason":"data_gap"',
          '"reason":"limit_exceeded","reason":"data_gap"',
        ) + '\n',
      ),
    ],
    ['depth', Buffer.from('['.repeat(9) + '0' + ']'.repeat(9) + '\n')],
    ['trailing frame', Buffer.from(raw + '\n' + raw + '\n')],
    ['partial extra frame', Buffer.from(raw + '\n{')],
    [
      'interactive response',
      Buffer.from('{"type":"ready","version":1,"generation":1,"resumed":false,"replayTruncated":false}\n'),
    ],
    ['extra field', Buffer.from(raw.replace('"loss":null', '"loss":null,"__proto__":{}') + '\n')],
    ['invalid escaped string', Buffer.from(raw.replace('recording_ready', 'recording\\qready') + '\n')],
  ];
  for (const [name, bytes] of invalid)
    await t.test(name, async (t) => {
      const { connecting, peer } = await opening(t);
      const rejection = assert.rejects(connecting, errorCode('invalid_response'));
      peer.socket.write(bytes);
      await rejection;
      await peer.closed;
    });
});

test('rejects unsolicited partial bytes and partial response EOF', async (t) => {
  for (const mode of ['unsolicited', 'EOF'])
    await t.test(mode, async (t) => {
      const { client, peer } = await connected(t);
      if (mode === 'unsolicited') peer.socket.write('{');
      else {
        const reading = client.read(0);
        const rejection = assert.rejects(reading, errorCode('transport_failed'));
        await peer.receive();
        peer.socket.end('{');
        await rejection;
      }
      const end = await client.ended;
      assert.equal(end.reason, 'error');
      if (end.reason === 'error')
        assert.equal(end.error.code, mode === 'unsolicited' ? 'invalid_response' : 'transport_failed');
    });
});

test('classifies complete unsolicited source errors without hiding malformed idle traffic', async (t) => {
  for (const code of [
    'FRAME_TOO_LARGE',
    'IDLE_TIMEOUT',
    'INVALID_FRAME',
    'SOURCE_MISMATCH',
    'INVALID_CURSOR',
    'RATE_LIMITED',
  ])
    await t.test(code, async (t) => {
      const { client, peer } = await connected(t);
      peer.socket.end(JSON.stringify({ type: 'error', code }) + '\n');
      const end = await client.ended;
      assert.equal(end.reason, 'error');
      if (end.reason !== 'error') assert.fail('source rejection must end the client');
      assert.equal(end.error.code, 'server_rejected');
      assert.equal(end.error.serverCode, code);
      assert.equal(end.error.message, 'Terminal recording source rejected the request.');
      assert.equal(end.error.cause, undefined);
      await peer.closed;
      client.close();
      assert.strictEqual(await client.ended, end);
      await assert.rejects(client.read(0), (error: unknown) => error === end.error);
      assert.equal(peer.waiting, 0);
    });

  const errorFrame = '{"type":"error","code":"IDLE_TIMEOUT"}';
  for (const [name, bytes] of [
    ['unsolicited ready', JSON.stringify(ready()) + '\n'],
    ['unsolicited page', JSON.stringify(page([dimensions()])) + '\n'],
    ['partial error', errorFrame.slice(0, -1)],
    ['missing newline', errorFrame],
    ['extra frame', errorFrame + '\n' + errorFrame + '\n'],
    ['extra partial frame', errorFrame + '\n{'],
    ['extra whitespace', errorFrame + '\n '],
    ['unknown error code', '{"type":"error","code":"private payload"}\n'],
    ['extra error field', '{"type":"error","code":"IDLE_TIMEOUT","message":"private payload"}\n'],
    ['missing error code', '{"type":"error"}\n'],
    ['wrong code type', '{"type":"error","code":1}\n'],
    ['duplicate error code', '{"type":"error","code":"private payload","code":"IDLE_TIMEOUT"}\n'],
    ['escaped duplicate error code', '{"type":"error","\\u0063ode":"private payload","code":"IDLE_TIMEOUT"}\n'],
    ['empty frame', '\n'],
    ['malformed JSON', '{\n'],
    ['excessive nesting', '['.repeat(9) + '0' + ']'.repeat(9) + '\n'],
    ['byte overflow', errorFrame + ' '.repeat(terminalRecordingSchema.maximumResponseBytes - errorFrame.length) + '\n'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28, 10])],
  ] as const)
    await t.test(name, async (t) => {
      const { client, peer } = await connected(t);
      peer.socket.write(bytes);
      const end = await client.ended;
      assert.equal(end.reason, 'error');
      if (end.reason !== 'error') assert.fail('invalid idle traffic must end the client');
      assert.equal(end.error.code, 'invalid_response');
      assert.equal(end.error.serverCode, undefined);
      assert.equal(end.error.cause, undefined);
      assert.ok(!JSON.stringify(end.error).includes('private payload'));
      await peer.closed;
      await assert.rejects(client.read(0), (error: unknown) => error === end.error);
    });
});

test('reuses private validators for exact page schemas, canonical bytes, cursors, and final exit', async (t) => {
  const invalid: Array<[string, unknown]> = [
    ['wrong source', page([dimensions()], { source: otherSource })],
    ['missing events', { ...page([]), events: undefined }],
    ['empty before latest', page([], { latestSequence: 2 })],
    ['wrong next cursor', page([dimensions()], { nextSequence: 0 })],
    ['skipped sequence', page([dimensions(2)], { latestSequence: 2 })],
    ['clock before start', page([{ ...dimensions(), recordedAt: time(-1) }])],
    ['clock after observation', page([{ ...dimensions(), recordedAt: time(11) }])],
    ['wrong initial dimensions', page([{ ...dimensions(), columns: 81 } as TerminalRecordingEvent])],
    [
      'invalid base64',
      page([dimensions(), { ...output(2, 2), data: 'YQ' } as TerminalRecordingEvent], { latestSequence: 2 }),
    ],
    [
      'oversize output',
      page([dimensions(), { ...output(2, 2), data: Buffer.alloc(8193).toString('base64') } as TerminalRecordingEvent], {
        latestSequence: 2,
      }),
    ],
    [
      'oversize input',
      page(
        [
          dimensions(),
          { sequence: 2, recordedAt: time(2), type: 'input', data: Buffer.alloc(16385).toString('base64') },
        ],
        { latestSequence: 2 },
      ),
    ],
    [
      'too many events',
      page(
        Array.from({ length: 101 }, (_, i) => dimensions(i + 1)),
        { latestSequence: 101 },
      ),
    ],
    [
      'exit without final phase',
      page([{ sequence: 2, recordedAt: time(2), type: 'exit', code: 7 }], { latestSequence: 2 }),
    ],
    ['exited without exit event', page([dimensions()], { shellState: 'exited' })],
    ['unknown event key', { ...page([dimensions()]), events: [{ ...dimensions(), private: 'hidden' }] }],
    ['duplicate event key', null],
  ];
  for (const [name, value] of invalid)
    await t.test(name, async (t) => {
      const { client, peer } = await connected(t);
      if (name === 'duplicate event key') {
        const reading = client.read(0);
        const rejection = assert.rejects(reading, errorCode('invalid_response'));
        await peer.receive();
        peer.socket.write(
          JSON.stringify(page([dimensions()])).replace(
            '"columns":80,"rows":24}',
            '"columns":500,"columns":80,"rows":24}',
          ) + '\n',
        );
        await rejection;
      } else await rejectedRead(client, peer, name === 'exit without final phase' ? 1 : 0, value);
    });
});

test('rejects metadata rollback and mutation across one connection', async (t) => {
  for (const changes of [
    { startedAt: time(1) },
    { observedAt: time(9) },
    { latestSequence: 1 },
    { shellState: 'running' as const },
    { loss: null },
    { loss: { reason: 'limit_exceeded' as const, occurredAt: time(5) } },
    { loss: { reason: 'data_gap' as const, occurredAt: time(6) } },
  ])
    await t.test(JSON.stringify(changes), async (t) => {
      const { client, peer } = await connected(
        t,
        ready({ latestSequence: 2, shellState: 'exiting', loss: { reason: 'data_gap', occurredAt: time(5) } }),
      );
      await rejectedRead(
        client,
        peer,
        0,
        page([dimensions()], {
          latestSequence: 2,
          shellState: 'exiting',
          loss: { reason: 'data_gap', occurredAt: time(5) },
          ...changes,
        }),
      );
    });
});

test('preserves first loss, permits only reserved final exit, and accepts reordered object keys', async (t) => {
  const loss = { reason: 'limit_exceeded' as const, occurredAt: time(5) };
  const { client, peer, ready: attached } = await connected(t, ready({ latestSequence: 2, loss }));
  attached.loss!.occurredAt = time(999);
  attached.latestSequence = 99;
  await respond(client, peer, 0, page([dimensions(), output(2, 2)], { latestSequence: 2, loss }));
  const final = page([{ sequence: 3, recordedAt: time(12), type: 'exit', code: 7 }], {
    latestSequence: 3,
    observedAt: time(20),
    shellState: 'exited',
    loss,
  });
  assert.deepEqual(await respond(client, peer, 2, final), final);
  assert.deepEqual(
    await respond(
      client,
      peer,
      3,
      page([], {
        latestSequence: 3,
        nextSequence: 3,
        observedAt: time(20),
        shellState: 'exited',
        loss: { occurredAt: time(5), reason: 'limit_exceeded' },
      }),
    ),
    { ...final, events: [], nextSequence: 3 },
  );
  assert.equal(
    (
      await respond(
        client,
        peer,
        0,
        page([dimensions(), output(2, 2), final.events[0]!], {
          latestSequence: 3,
          observedAt: time(20),
          shellState: 'exited',
          loss,
        }),
      )
    ).events.length,
    3,
  );
});

test('rejects resumed normal data or more than one final sequence after observed loss', async (t) => {
  for (const shellState of ['running', 'exiting', 'exited'] as const)
    await t.test(shellState, async (t) => {
      const loss = { reason: 'data_gap' as const, occurredAt: time(5) };
      const { client, peer } = await connected(t, ready({ loss }));
      await rejectedRead(
        client,
        peer,
        0,
        page([dimensions()], { latestSequence: shellState === 'exited' ? 3 : 2, shellState, loss }),
      );
    });
});

test('freezes exited state and loss, but allows later observation time', async (t) => {
  for (const changes of [
    { latestSequence: 3 },
    { shellState: 'exiting' as const },
    { loss: { reason: 'data_gap' as const, occurredAt: time(5) } },
  ])
    await t.test(JSON.stringify(changes), async (t) => {
      const { client, peer } = await connected(t, ready({ latestSequence: 2, shellState: 'exited' }));
      await respond(
        client,
        peer,
        2,
        page([], { latestSequence: 2, nextSequence: 2, shellState: 'exited', observedAt: time(20) }),
      );
      await rejectedRead(
        client,
        peer,
        0,
        page([dimensions()], { latestSequence: 2, shellState: 'exited', observedAt: time(21), ...changes }),
      );
    });
});

test('checks clocks and replay identity at a bounded frontier without retaining full history', async (t) => {
  for (const mode of ['adjacent', 'overlap earlier', 'overlap later', 'changed payload', 'changed time'])
    await t.test(mode, async (t) => {
      const { client, peer } = await connected(t, ready({ latestSequence: 4 }));
      await respond(client, peer, 1, page([output(2, 4)], { latestSequence: 4 }));
      const response =
        mode === 'adjacent'
          ? page([output(3, 3)], { latestSequence: 4 })
          : mode === 'overlap earlier'
            ? page([dimensions(1, 5)], { latestSequence: 4 })
            : mode === 'overlap later'
              ? page([output(3, 3), output(4, 4)], { latestSequence: 4 })
              : mode === 'changed payload'
                ? page([{ ...output(2, 4), data: 'YWJj' } as TerminalRecordingEvent], { latestSequence: 4 })
                : page([output(2, 5)], { latestSequence: 4 });
      await rejectedRead(
        client,
        peer,
        mode === 'overlap earlier' ? 0 : mode === 'adjacent' || mode === 'overlap later' ? 2 : 1,
        response,
      );
    });
});

test('maps only allowlisted server errors and never retains remote error text', async (t) => {
  for (const code of [
    'FRAME_TOO_LARGE',
    'IDLE_TIMEOUT',
    'INVALID_FRAME',
    'SOURCE_MISMATCH',
    'INVALID_CURSOR',
    'RATE_LIMITED',
    'secret-address',
    'RATE_LIMITED_WITH_TEXT',
  ])
    await t.test(code, async (t) => {
      const { client, peer } = await connected(t);
      const reading = client.read(100_000);
      const rejection = assert.rejects(reading, (error: unknown) => {
        assert.ok(error instanceof TerminalRecordingClientError);
        if (code === 'secret-address' || code === 'RATE_LIMITED_WITH_TEXT')
          assert.equal(error.code, 'invalid_response');
        else {
          assert.equal(error.code, 'server_rejected');
          assert.equal(error.serverCode, code);
        }
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes('private payload'));
        return true;
      });
      assert.deepEqual(await peer.receive(), { type: 'read', source, after: 100_000 });
      peer.send(
        code === 'RATE_LIMITED_WITH_TEXT'
          ? { type: 'error', code: 'RATE_LIMITED', message: 'private payload' }
          : { type: 'error', code },
      );
      await rejection;
      await peer.closed;
    });
});

test('still accepts fragmented source errors for pending attach and read operations', async (t) => {
  for (const mode of ['attach', 'read'])
    await t.test(mode, async (t) => {
      const setup = await opening(t);
      let waiting: Promise<unknown> = setup.connecting;
      let client: TerminalRecordingClient | undefined;
      if (mode === 'read') {
        setup.peer.send(ready());
        ({ client } = await setup.connecting);
        waiting = client.read(0);
        await setup.peer.receive();
      }
      const rejection = assert.rejects(
        waiting,
        (error: unknown) =>
          error instanceof TerminalRecordingClientError &&
          error.code === 'server_rejected' &&
          error.serverCode === 'IDLE_TIMEOUT',
      );
      setup.peer.socket.write('{"type":"error",');
      await delay(10);
      setup.peer.socket.end('"code":"IDLE_TIMEOUT"}\n');
      await rejection;
      await setup.peer.closed;
      if (client) {
        const end = await client.ended;
        assert.equal(end.reason, 'error');
        if (end.reason === 'error') assert.equal(end.error.serverCode, 'IDLE_TIMEOUT');
      }
    });
});

test('closes timed-out attach and read even when bytes keep arriving', async (t) => {
  for (const mode of ['attach', 'read', 'trickle'])
    await t.test(mode, async (t) => {
      const setup = await opening(t, { requestTimeoutMs: 100 });
      let waiting: Promise<unknown> = setup.connecting;
      let client: TerminalRecordingClient | undefined;
      if (mode !== 'attach') {
        setup.peer.send(ready());
        ({ client } = await setup.connecting);
        waiting = client.read(0);
        await setup.peer.receive();
      }
      const rejection = assert.rejects(waiting, errorCode('request_timeout'));
      const interval = mode === 'trickle' ? setInterval(() => setup.peer.socket.write(' '), 10) : undefined;
      try {
        await rejection;
        await setup.peer.closed;
      } finally {
        clearInterval(interval);
        client?.close();
      }
    });
});

test('in-flight abort and caller close settle the pending operation and exclude late responses', async (t) => {
  for (const mode of ['abort', 'close'])
    await t.test(mode, async (t) => {
      const { client, peer } = await connected(t);
      const controller = new AbortController();
      const reading = client.read(0, controller.signal);
      const code = mode === 'abort' ? 'cancelled' : 'closed';
      const rejection = assert.rejects(reading, errorCode(code));
      await peer.receive();
      if (mode === 'abort') controller.abort();
      else client.close();
      await rejection;
      peer.send(page([dimensions()]));
      await peer.closed;
      await assert.rejects(client.read(0), errorCode(code));
    });
});

test('cancels pending attach and bounds a stalled TCP connection', async (t) => {
  await t.test('attach abort', async (t) => {
    const setup = await fixture(t);
    const controller = new AbortController();
    const connecting = TerminalRecordingClient.connect(setup.options, controller.signal);
    const rejection = assert.rejects(connecting, errorCode('cancelled'));
    const peer = await setup.accept();
    await peer.receive();
    controller.abort();
    await rejection;
    await peer.closed;
  });
  // A deterministic stalled connect avoids relying on external routing or a black-hole address.
  await t.test('connect deadline', async (t) => {
    t.mock.method(Socket.prototype, 'connect', function (this: Socket) {
      return this;
    });
    await assert.rejects(
      TerminalRecordingClient.connect({ host: '127.0.0.1', connectTimeoutMs: 20 }),
      errorCode('connect_timeout'),
    );
  });
  await t.test('connect abort', async (t) => {
    t.mock.method(Socket.prototype, 'connect', function (this: Socket) {
      return this;
    });
    const controller = new AbortController();
    const connecting = TerminalRecordingClient.connect({ host: '127.0.0.1' }, controller.signal);
    const rejection = assert.rejects(connecting, errorCode('cancelled'));
    controller.abort();
    await rejection;
  });
});

test('rejects backdated new observations and accepts the equal-millisecond boundary', async (t) => {
  await t.test('new event', async (t) => {
    const { client, peer } = await connected(t);
    await rejectedRead(client, peer, 1, page([output(2, 9)], { latestSequence: 2, observedAt: time(20) }));
  });
  await t.test('new loss', async (t) => {
    const { client, peer } = await connected(t);
    await rejectedRead(
      client,
      peer,
      1,
      page([], { observedAt: time(20), loss: { reason: 'data_gap', occurredAt: time(9) } }),
    );
  });
  await t.test('equal boundary', async (t) => {
    const { client, peer } = await connected(t);
    const response = page([output(2, 10)], {
      latestSequence: 2,
      observedAt: time(20),
      loss: { reason: 'data_gap', occurredAt: time(10) },
    });
    assert.deepEqual(await respond(client, peer, 1, response), response);
  });
});

test('checks adjacent replay pages below the high frontier, including after an empty read', async (t) => {
  const { client, peer } = await connected(t, ready({ latestSequence: 5 }));
  await respond(client, peer, 4, page([output(5, 9)], { latestSequence: 5 }));
  await respond(client, peer, 0, page([dimensions(), output(2, 5)], { latestSequence: 5 }));
  await respond(client, peer, 5, page([], { latestSequence: 5, nextSequence: 5 }));
  await rejectedRead(client, peer, 2, page([output(3, 4)], { latestSequence: 5 }));
});

test('requires a new final exit sequence when the shell becomes exited', async (t) => {
  const { client, peer } = await connected(t);
  await rejectedRead(client, peer, 1, page([], { shellState: 'exited' }));
});

test('accepts maximum-sized bytes, maximum page count, escaped keys, and reordered event keys', async (t) => {
  const { client, peer } = await connected(t, ready({ latestSequence: 103 }));
  const events = Array.from({ length: 100 }, (_, i) => dimensions(i + 1, 1));
  assert.equal((await respond(client, peer, 0, page(events, { latestSequence: 103 }))).events.length, 100);
  const input: TerminalRecordingEvent = {
    sequence: 101,
    recordedAt: time(2),
    type: 'input',
    data: Buffer.alloc(16_384, 0xff).toString('base64'),
  };
  assert.deepEqual((await respond(client, peer, 100, page([input], { latestSequence: 103 }))).events[0], input);
  const outputEvent: TerminalRecordingEvent = {
    sequence: 102,
    recordedAt: time(3),
    type: 'output',
    data: Buffer.alloc(8_192, 0xff).toString('base64'),
  };
  const reading = client.read(101);
  await peer.receive();
  peer.socket.write(
    JSON.stringify(page([outputEvent], { latestSequence: 103 })).replace('"events"', '"\\u0065vents"') + '\n',
  );
  assert.deepEqual((await reading).events[0], outputEvent);
  assert.deepEqual(
    (
      await respond(
        client,
        peer,
        101,
        page([{ data: outputEvent.data, type: 'output', recordedAt: time(3), sequence: 102 }], { latestSequence: 103 }),
      )
    ).events[0],
    outputEvent,
  );
});

test('sanitizes synchronous transport failures and asynchronous socket loss without retries', async (t) => {
  await t.test('connect throw', async (t) => {
    t.mock.method(Socket.prototype, 'connect', () => {
      throw new Error('private address');
    });
    await assert.rejects(TerminalRecordingClient.connect({ host: '127.0.0.1' }), errorCode('transport_failed'));
  });
  await t.test('write throw', async (t) => {
    const { client } = await connected(t);
    t.mock.method(Socket.prototype, 'write', () => {
      throw new Error('private payload');
    });
    await assert.rejects(client.read(0), errorCode('transport_failed'));
  });
  await t.test('socket close', async (t) => {
    const { client, peer } = await connected(t);
    const reading = client.read(0);
    const rejection = assert.rejects(reading, errorCode('transport_failed'));
    await peer.receive();
    peer.socket.destroy();
    await rejection;
    await assert.rejects(client.read(0), errorCode('transport_failed'));
  });
});
