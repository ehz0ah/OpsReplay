import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import { TerminalClient, TerminalClientError } from '../src/terminal-client.js';

class Peer {
  private readonly iterator;
  private buffer = Buffer.alloc(0);

  constructor(readonly socket: Socket) {
    this.iterator = socket[Symbol.asyncIterator]();
  }

  async receive(timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(timeoutMs);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        return JSON.parse(line.toString('utf8')) as Record<string, unknown>;
      }
      const next = await Promise.race([
        this.iterator.next(),
        new Promise<never>((_, reject) => {
          timeout.addEventListener('abort', () => reject(new Error('timed out waiting for client frame')), {
            once: true,
          });
        }),
      ]);
      if (next.done) throw new Error('client closed before sending a frame');
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    }
  }

  send(frame: Record<string, unknown>, splitAt?: number): void {
    const encoded = Buffer.from(JSON.stringify(frame) + '\n');
    if (splitAt === undefined) {
      this.socket.write(encoded);
      return;
    }
    this.socket.write(encoded.subarray(0, splitAt));
    this.socket.write(encoded.subarray(splitAt));
  }

  sendRaw(value: Buffer): void {
    this.socket.write(value);
  }

  bufferedBytes(): number {
    return this.buffer.length + this.socket.readableLength;
  }
}

async function fixture(t: TestContext): Promise<{ server: Server; port: number; accept: Promise<Peer> }> {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const accept = once(server, 'connection').then(([socket]) => new Peer(socket as Socket));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { server, port: address.port, accept };
}

const options = (port: number, onOutput: (data: Buffer) => void | Promise<void> = () => undefined) => ({
  host: '127.0.0.1',
  port,
  generation: 7,
  columns: 100,
  rows: 30,
  onOutput,
  connectTimeoutMs: 1_000,
  operationTimeoutMs: 1_000,
});

function ready(peer: Peer, resumed = false, replayTruncated = false, splitAt?: number): void {
  peer.send(
    {
      type: 'ready',
      version: 1,
      generation: 7,
      resumed,
      replayTruncated,
    },
    splitAt,
  );
}

function errorCode(code: TerminalClientError['code']) {
  return (error: unknown) => error instanceof TerminalClientError && error.code === code;
}

async function connect(t: TestContext, onOutput?: (data: Buffer) => void | Promise<void>) {
  const setup = await fixture(t);
  const connecting = TerminalClient.connect(options(setup.port, onOutput));
  const peer = await setup.accept;
  assert.deepEqual(await peer.receive(), {
    type: 'attach',
    version: 1,
    mode: 'interactive',
    generation: 7,
    columns: 100,
    rows: 30,
  });
  return { ...setup, connecting, peer };
}

test('attaches and handles fragmented readiness, output, resize, heartbeat, and exit', async (t) => {
  const output: string[] = [];
  const { connecting, peer } = await connect(t, async (data) => {
    await delay(5);
    output.push(data.toString());
  });
  ready(peer, true, true, 9);
  const { client, ready: attached } = await connecting;
  assert.deepEqual(attached, { resumed: true, replayTruncated: true });
  await assert.rejects(client.input(Buffer.alloc(0)), /between 1 and 16384 bytes/);

  const input = client.input(Buffer.from('printf hello\n'));
  assert.deepEqual(await peer.receive(), {
    type: 'input',
    generation: 7,
    data: Buffer.from('printf hello\n').toString('base64'),
  });
  peer.send({ type: 'output', generation: 7, data: Buffer.from('hello').toString('base64') });
  peer.send({ type: 'input_accepted', generation: 7 });
  await input;
  assert.deepEqual(output, ['hello']);

  const resize = client.resize(120, 40);
  assert.deepEqual(await peer.receive(), { type: 'resize', generation: 7, columns: 120, rows: 40 });
  peer.send({ type: 'resize_accepted', generation: 7 });
  await resize;

  const heartbeat = client.heartbeat();
  assert.deepEqual(await peer.receive(), { type: 'heartbeat', generation: 7 });
  peer.send({ type: 'heartbeat', generation: 7 });
  await heartbeat;

  peer.send({ type: 'exit', code: 0 });
  assert.deepEqual(await client.ended, { reason: 'exit', code: 0 });
  await assert.rejects(client.heartbeat(), errorCode('shell_exited'));
});

test('serializes input operations because acknowledgements have no request identifier', async (t) => {
  const { connecting, peer } = await connect(t);
  ready(peer);
  const { client } = await connecting;

  const first = client.input(Buffer.from('first'));
  const second = client.input(Buffer.from('second'));
  assert.equal(Buffer.from(String((await peer.receive()).data), 'base64').toString(), 'first');
  await delay(20);
  assert.equal(peer.bufferedBytes(), 0);
  peer.send({ type: 'input_accepted', generation: 7 });
  await first;

  assert.equal(Buffer.from(String((await peer.receive()).data), 'base64').toString(), 'second');
  peer.send({ type: 'input_accepted', generation: 7 });
  await second;
  client.close();
  assert.deepEqual(await client.ended, { reason: 'closed' });
});

test('reports uncertain input and never reconnects when the acknowledgement is lost', async (t) => {
  const { server, connecting, peer } = await connect(t);
  let connections = 1;
  server.on('connection', () => connections++);
  ready(peer);
  const { client } = await connecting;

  const input = client.input(Buffer.from('might-run'));
  assert.equal(Buffer.from(String((await peer.receive()).data), 'base64').toString(), 'might-run');
  peer.socket.destroy();
  await assert.rejects(input, errorCode('input_uncertain'));
  const end = await client.ended;
  assert.equal(end.reason, 'error');
  if (end.reason === 'error') assert.equal(end.error.code, 'transport_failed');
  await delay(20);
  assert.equal(connections, 1);
});

test('reports uncertain input when the shell exits before acknowledging it', async (t) => {
  const { connecting, peer } = await connect(t);
  ready(peer);
  const { client } = await connecting;

  const input = client.input(Buffer.from('exit\n'));
  await peer.receive();
  peer.send({ type: 'exit', code: 0 });
  await assert.rejects(input, errorCode('input_uncertain'));
  assert.deepEqual(await client.ended, { reason: 'exit', code: 0 });
});

test('closes the connection and reports uncertain input after an acknowledgement timeout', async (t) => {
  const setup = await fixture(t);
  const connecting = TerminalClient.connect({ ...options(setup.port), operationTimeoutMs: 25 });
  const peer = await setup.accept;
  await peer.receive();
  ready(peer);
  const { client } = await connecting;

  const input = client.input(Buffer.from('slow-ack'));
  await peer.receive();
  await assert.rejects(input, errorCode('input_uncertain'));
  const end = await client.ended;
  assert.equal(end.reason, 'error');
  if (end.reason === 'error') assert.equal(end.error.code, 'operation_timeout');
});

test('maps explicit server errors and rejects stale generations without an input retry', async (t) => {
  const { connecting, peer } = await connect(t);
  peer.send({ type: 'error', code: 'STALE_GENERATION' });
  await assert.rejects(connecting, errorCode('stale_generation'));
});

test('reports replacement after a successful attach', async (t) => {
  const { connecting, peer } = await connect(t);
  ready(peer);
  const { client } = await connecting;
  peer.send({ type: 'error', code: 'REPLACED' });
  const end = await client.ended;
  assert.equal(end.reason, 'error');
  if (end.reason === 'error') {
    assert.equal(end.error.code, 'replaced');
    assert.equal(end.error.serverCode, 'REPLACED');
  }
});

test('fails closed on malformed, oversized, and wrong-generation responses', async (t) => {
  await t.test('invalid base64', async (t) => {
    const { connecting, peer } = await connect(t);
    ready(peer);
    const { client } = await connecting;
    peer.send({ type: 'output', generation: 7, data: '***=' });
    const end = await client.ended;
    assert.equal(end.reason, 'error');
    if (end.reason === 'error') assert.equal(end.error.code, 'invalid_response');
  });

  await t.test('oversized line', async (t) => {
    const { connecting, peer } = await connect(t);
    peer.sendRaw(Buffer.alloc(24 * 1024 + 1, 0x61));
    await assert.rejects(connecting, errorCode('invalid_response'));
  });

  await t.test('wrong generation', async (t) => {
    const { connecting, peer } = await connect(t);
    peer.send({
      type: 'ready',
      version: 1,
      generation: 8,
      resumed: false,
      replayTruncated: false,
    });
    await assert.rejects(connecting, errorCode('invalid_response'));
  });
});

test('cancellation closes an in-flight attach and output consumer failure closes an attached client', async (t) => {
  await t.test('cancelled attach', async (t) => {
    const setup = await fixture(t);
    const controller = new AbortController();
    const connecting = TerminalClient.connect(options(setup.port), controller.signal);
    const peer = await setup.accept;
    await peer.receive();
    controller.abort(new Error('test cancellation'));
    await assert.rejects(connecting, errorCode('cancelled'));
  });

  await t.test('output failure', async (t) => {
    const { connecting, peer } = await connect(t, () => {
      throw new Error('downstream stopped');
    });
    ready(peer);
    const { client } = await connecting;
    peer.send({ type: 'output', generation: 7, data: Buffer.from('data').toString('base64') });
    const end = await client.ended;
    assert.equal(end.reason, 'error');
    if (end.reason === 'error') assert.equal(end.error.code, 'output_failed');
  });
});

test('validates configuration before opening a connection', async () => {
  await assert.rejects(
    TerminalClient.connect({ ...options(7681), host: 'terminal.internal' }),
    /Terminal host must be an IP address/,
  );
  await assert.rejects(TerminalClient.connect({ ...options(7681), generation: 0 }), /positive safe integer/);
});
