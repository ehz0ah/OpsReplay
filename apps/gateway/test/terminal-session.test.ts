import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TerminalAdmissionError,
  type TerminalAdmission,
  type TerminalAdmissionRequest,
  type TerminalAdmissionStore,
  type TerminalInputAuthorization,
} from '../src/terminal-admission-store.js';
import { GatewayTerminalSession, type TerminalConnection, type TerminalConnector } from '../src/terminal-session.js';
import { TerminalClientError, type TerminalClientOptions } from '../src/terminal-client.js';

const admission: TerminalAdmission = {
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  taskAddress: '10.0.1.42',
  connectionId: 'gateway-connection-1',
  generation: 7,
};
const options = {
  sessionId: admission.sessionId,
  ticket: 'a'.repeat(43),
  columns: 120,
  rows: 32,
  onOutput: () => undefined,
};

function fixture() {
  const admissions: TerminalAdmissionRequest[] = [];
  const authorizations: TerminalInputAuthorization[] = [];
  const calls: string[] = [];
  let authorizationError: Error | undefined;
  const store: TerminalAdmissionStore = {
    admit: async (request) => {
      admissions.push(request);
      return admission;
    },
    authorizeInput: async (request) => {
      authorizations.push(request);
      if (authorizationError) throw authorizationError;
    },
  };
  const terminal: TerminalConnection = {
    ended: new Promise(() => undefined),
    input: async (data) => {
      calls.push(`input:${Buffer.from(data).toString()}`);
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
  let connected: TerminalClientOptions | undefined;
  const connect: TerminalConnector = async (value) => {
    connected = value;
    return { client: terminal, ready: { resumed: true, replayTruncated: false } };
  };
  return {
    store,
    terminal,
    connect,
    admissions,
    authorizations,
    calls,
    connected: () => connected,
    dependencies: {
      admissions: store,
      connect,
      newConnectionId: () => admission.connectionId,
      now: () => new Date('2026-10-10T08:00:00.000Z'),
    },
    failAuthorization(error: Error) {
      authorizationError = error;
    },
  };
}

test('admits before connecting and exposes readiness only after terminal attachment', async () => {
  const f = fixture();
  const opened = await GatewayTerminalSession.open(options, f.dependencies);

  assert.deepEqual(f.admissions, [
    {
      sessionId: admission.sessionId,
      ticket: options.ticket,
      connectionId: admission.connectionId,
      now: '2026-10-10T08:00:00.000Z',
    },
  ]);
  assert.deepEqual(
    {
      host: f.connected()?.host,
      generation: f.connected()?.generation,
      columns: f.connected()?.columns,
      rows: f.connected()?.rows,
    },
    { host: '10.0.1.42', generation: 7, columns: 120, rows: 32 },
  );
  assert.equal(f.connected()?.onOutput, options.onOutput);
  assert.deepEqual(opened.ready, {
    sessionId: admission.sessionId,
    generation: 7,
    resumed: true,
    replayTruncated: false,
  });
  assert.equal(opened.session.sessionId, admission.sessionId);
  assert.equal(opened.session.generation, 7);
});

test('checks current ownership before every terminal operation', async () => {
  const f = fixture();
  const { session } = await GatewayTerminalSession.open(options, f.dependencies);

  await session.input(Buffer.from('whoami\n'));
  await session.resize(100, 28);
  await session.heartbeat();

  assert.deepEqual(f.authorizations, [
    { sessionId: admission.sessionId, connectionId: admission.connectionId, generation: 7 },
    { sessionId: admission.sessionId, connectionId: admission.connectionId, generation: 7 },
    { sessionId: admission.sessionId, connectionId: admission.connectionId, generation: 7 },
  ]);
  assert.deepEqual(f.calls, ['input:whoami\n', 'resize:100x28', 'heartbeat']);
});

test('closes the private terminal before rejecting replaced or terminal sessions', async () => {
  for (const code of ['replaced', 'session_terminal'] as const) {
    const f = fixture();
    const { session } = await GatewayTerminalSession.open(options, f.dependencies);
    f.failAuthorization(new TerminalAdmissionError(code));

    await assert.rejects(session.input(Buffer.from('must-not-run\n')), (error: unknown) => {
      return error instanceof TerminalAdmissionError && error.code === code;
    });
    assert.deepEqual(f.calls, ['close']);
  }
});

test('does not connect when admission fails', async () => {
  const f = fixture();
  f.store.admit = async () => {
    throw new TerminalAdmissionError('auth_failed');
  };

  await assert.rejects(
    GatewayTerminalSession.open(options, f.dependencies),
    (error: unknown) => error instanceof TerminalAdmissionError && error.code === 'auth_failed',
  );
  assert.equal(f.connected(), undefined);
});

test('does not retry or roll back a claimed generation after terminal connection failure', async () => {
  const f = fixture();
  let connections = 0;
  const connect: TerminalConnector = async () => {
    connections++;
    throw new TerminalClientError('connect_timeout');
  };

  await assert.rejects(
    GatewayTerminalSession.open(options, { ...f.dependencies, connect }),
    (error: unknown) => error instanceof TerminalClientError && error.code === 'connect_timeout',
  );
  assert.equal(f.admissions.length, 1);
  assert.equal(connections, 1);
});

test('preserves uncertain input without retrying it', async () => {
  const f = fixture();
  let inputs = 0;
  f.terminal.input = async () => {
    inputs++;
    throw new TerminalClientError('input_uncertain');
  };
  const { session } = await GatewayTerminalSession.open(options, f.dependencies);

  await assert.rejects(
    session.input(Buffer.from('possibly-ran\n')),
    (error: unknown) => error instanceof TerminalClientError && error.code === 'input_uncertain',
  );
  assert.equal(inputs, 1);
});
