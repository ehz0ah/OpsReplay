import assert from 'node:assert/strict';
import { createServer, get, type Server } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { GatewayAwsClients } from '../src/aws.js';
import type { GatewayBrowserTerminalRelayOptions } from '../src/browser-terminal-relay.js';
import {
  createGatewayRecorderId,
  loadGatewayRuntimeConfiguration,
  runGatewayRuntime,
  type GatewayRuntimeConfiguration,
  type GatewayRuntimeDependencies,
  type GatewayRuntimeEvent,
} from '../src/gateway-runtime.js';
import type { TerminalAdmissionStore } from '../src/terminal-admission-store.js';

const recordingEnvironment = {
  SESSION_TABLE_NAME: 'opsreplay-sessions',
  RECORDING_BUCKET_NAME: 'opsreplay-recordings',
  MAXIMUM_CONCURRENT_RECORDINGS: '16',
  MONITOR_PORT: '9443',
};

const terminalEnvironment = {
  GATEWAY_PORT: '8080',
  TERMINAL_ALLOWED_ORIGINS: 'https://app.opsreplay.test,http://localhost:3000',
  MAXIMUM_TERMINAL_CONNECTIONS: '256',
  MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS: '32',
  TERMINAL_PORT: '7681',
};

const fullEnvironment = { ...recordingEnvironment, ...terminalEnvironment };

test('loads the complete bounded gateway runtime configuration', () => {
  assert.deepEqual(loadGatewayRuntimeConfiguration(fullEnvironment), {
    sessionTableName: 'opsreplay-sessions',
    recordingBucketName: 'opsreplay-recordings',
    maximumConcurrentRecordings: 16,
    monitorPort: 9443,
    terminal: {
      listenPort: 8080,
      allowedOrigins: ['https://app.opsreplay.test', 'http://localhost:3000'],
      maximumConnections: 256,
      maximumPendingAuthentications: 32,
      terminalPort: 7681,
    },
  });
});

test('keeps the terminal listener disabled when no terminal setting is supplied', () => {
  assert.equal(loadGatewayRuntimeConfiguration(recordingEnvironment).terminal, null);
});

test('creates a distinct bounded recorder identity for each process', () => {
  const first = createGatewayRecorderId();
  const second = createGatewayRecorderId();
  assert.match(first, /^gateway-[0-9a-f-]{36}$/);
  assert.match(second, /^gateway-[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

for (const [name, value] of [
  ['SESSION_TABLE_NAME', 'x'],
  ['RECORDING_BUCKET_NAME', '127.0.0.1'],
  ['MAXIMUM_CONCURRENT_RECORDINGS', '0'],
  ['MAXIMUM_CONCURRENT_RECORDINGS', '65'],
  ['MAXIMUM_CONCURRENT_RECORDINGS', '1.5'],
  ['MONITOR_PORT', '65536'],
  ['MONITOR_PORT', ' 9443'],
  ['GATEWAY_PORT', '0'],
  ['GATEWAY_PORT', '65536'],
  ['MAXIMUM_TERMINAL_CONNECTIONS', '0'],
  ['MAXIMUM_TERMINAL_CONNECTIONS', '4097'],
  ['MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS', '0'],
  ['MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS', '1025'],
  ['TERMINAL_PORT', '0'],
  ['TERMINAL_PORT', '65536'],
] as const) {
  test(`rejects invalid ${name}`, () => {
    assert.throws(() => loadGatewayRuntimeConfiguration({ ...fullEnvironment, [name]: value }), {
      message: `${name} is invalid`,
    });
  });
}

for (const value of [
  '',
  'ftp://app.opsreplay.test',
  'https://user@app.opsreplay.test',
  'https://app.opsreplay.test/path',
  'https://app.opsreplay.test?query=yes',
  'https://app.opsreplay.test,https://app.opsreplay.test:443',
]) {
  test(`rejects invalid terminal origins: ${value || 'empty'}`, () => {
    assert.throws(() => loadGatewayRuntimeConfiguration({ ...fullEnvironment, TERMINAL_ALLOWED_ORIGINS: value }), {
      message: 'TERMINAL_ALLOWED_ORIGINS is invalid',
    });
  });
}

test('rejects partial terminal configuration', () => {
  assert.throws(() => loadGatewayRuntimeConfiguration({ ...recordingEnvironment, GATEWAY_PORT: '8080' }), {
    message: 'Terminal runtime configuration is incomplete',
  });
});

test('rejects a pending-authentication cap above the total connection cap', () => {
  assert.throws(
    () =>
      loadGatewayRuntimeConfiguration({
        ...fullEnvironment,
        MAXIMUM_TERMINAL_CONNECTIONS: '31',
        MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS: '32',
      }),
    { message: 'MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS is invalid' },
  );
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function configuration(terminal = true): GatewayRuntimeConfiguration {
  const loaded = loadGatewayRuntimeConfiguration(terminal ? fullEnvironment : recordingEnvironment);
  return loaded.terminal === null ? loaded : { ...loaded, terminal: { ...loaded.terminal, listenPort: 0 } };
}

function httpRequest(port: number, path: string): Promise<{ status: number; body: string; cache: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          cache: response.headers['cache-control'],
        }),
      );
    });
    request.once('error', reject);
  });
}

function fixture(run?: (signal: AbortSignal) => Promise<void>) {
  const supervisorStarted = deferred<void>();
  const events: GatewayRuntimeEvent[] = [];
  const actions: string[] = [];
  const clients = { dynamo: {}, s3: {}, close: () => actions.push('clients_closed') } as unknown as GatewayAwsClients;
  const admissions = {} as TerminalAdmissionStore;
  let server: Server | undefined;
  let relayOptions: GatewayBrowserTerminalRelayOptions | undefined;
  let supervisorOptions: Record<string, unknown> | undefined;
  let supervisorRuns = 0;
  const dependencies: GatewayRuntimeDependencies = {
    createClients: () => clients,
    createRecorderId: () => 'gateway-test',
    createSupervisor: (value, actualClients) => {
      assert.equal(actualClients, clients);
      supervisorOptions = value as unknown as Record<string, unknown>;
      return {
        run: async (signal) => {
          supervisorRuns++;
          supervisorStarted.resolve();
          if (run !== undefined) return run(signal);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          actions.push('supervisor_stopped');
        },
      };
    },
    createAdmissions: (client, tableName) => {
      assert.equal(client, clients.dynamo);
      assert.equal(tableName, 'opsreplay-sessions');
      return admissions;
    },
    createRelay: (actualServer, options) => {
      assert.equal(actualServer, server);
      assert.equal(options.admissions, admissions);
      relayOptions = options;
      return {
        close: async () => {
          actions.push('relay_closed');
        },
      };
    },
    createHttpServer: (listener) => {
      server = createServer(listener);
      return server;
    },
    report: (event) => events.push(event),
  };
  return {
    actions,
    dependencies,
    events,
    relayOptions: () => relayOptions,
    server: () => server,
    supervisorOptions: () => supervisorOptions,
    supervisorRuns: () => supervisorRuns,
    supervisorStarted: supervisorStarted.promise,
  };
}

test('runs the recording supervisor and terminal listener in one process', async () => {
  const controller = new AbortController();
  const f = fixture();
  const running = runGatewayRuntime(configuration(), controller.signal, f.dependencies);
  await f.supervisorStarted;
  const started = f.events.find((event) => event.type === 'service_started');
  assert.ok(started?.listenPort);

  assert.deepEqual(await httpRequest(started.listenPort, '/healthz'), {
    status: 200,
    body: '{"status":"ready"}\n',
    cache: 'no-store',
  });
  assert.deepEqual(await httpRequest(started.listenPort, '/unknown'), {
    status: 404,
    body: '',
    cache: 'no-store',
  });
  assert.deepEqual(f.relayOptions(), {
    allowedOrigins: ['https://app.opsreplay.test', 'http://localhost:3000'],
    admissions: f.relayOptions()?.admissions,
    maxConnections: 256,
    maxPendingAuthentications: 32,
    terminalPort: 7681,
  });
  assert.equal(f.supervisorOptions()?.recorderId, 'gateway-test');
  assert.equal(f.supervisorOptions()?.maximumConcurrentRecordings, 16);
  assert.equal(f.server()?.maxConnections, 288);

  controller.abort();
  await running;
  assert.ok(f.actions.includes('relay_closed'));
  assert.ok(f.actions.includes('supervisor_stopped'));
  assert.equal(f.actions.at(-1), 'clients_closed');
  assert.deepEqual(f.events.at(-1), { type: 'service_stopped', recorderId: 'gateway-test' });
});

test('forces an incomplete HTTP request closed after a fatal recording failure', async () => {
  const controller = new AbortController();
  const failSupervisor = deferred<void>();
  const failure = new Error('fatal');
  const f = fixture(async () => {
    await failSupervisor.promise;
    throw failure;
  });
  const running = runGatewayRuntime(configuration(), controller.signal, f.dependencies);
  await f.supervisorStarted;
  const started = f.events.find((event) => event.type === 'service_started');
  assert.ok(started?.listenPort);

  const socket = connect(started.listenPort, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => {
        socket.off('error', reject);
        resolve();
      };
      socket.once('connect', connected);
      socket.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.write('GET /healthz HTTP/1.1\r\nHost: gateway.test\r\n', (error) =>
        error == null ? resolve() : reject(error),
      );
    });

    socket.on('error', () => {
      /* Forced shutdown can reset the incomplete request. */
    });
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    failSupervisor.resolve();
    const completed = Promise.all([assert.rejects(running, failure), closed]);
    const timedOut = await Promise.race([completed.then(() => false), delay(1_000, true, { ref: false })]);
    assert.equal(timedOut, false);
    assert.equal(socket.destroyed, true);
    assert.equal(f.actions.at(-1), 'clients_closed');
  } finally {
    socket.destroy();
    failSupervisor.resolve();
    controller.abort();
    await Promise.allSettled([running]);
  }
});

test('preserves the recording-only runtime when terminal settings are absent', async () => {
  const controller = new AbortController();
  const f = fixture(async (signal) => controller.abort(signal.reason));
  await runGatewayRuntime(configuration(false), controller.signal, f.dependencies);
  assert.equal(f.server(), undefined);
  assert.equal(f.events.find((event) => event.type === 'service_started')?.listenPort, null);
  assert.deepEqual(f.actions, ['clients_closed']);
});

test('closes the listener and clients after a fatal recording failure', async () => {
  const failure = new Error('fatal');
  const f = fixture(async () => {
    throw failure;
  });
  await assert.rejects(runGatewayRuntime(configuration(), new AbortController().signal, f.dependencies), failure);
  assert.equal(f.server()?.listening, false);
  assert.ok(f.actions.includes('relay_closed'));
  assert.equal(f.actions.at(-1), 'clients_closed');
});

test('stops recording and closes clients after a listener failure', async () => {
  const controller = new AbortController();
  const f = fixture();
  const running = runGatewayRuntime(configuration(), controller.signal, f.dependencies);
  await f.supervisorStarted;
  const failure = new Error('listener failed');
  f.server()?.emit('error', failure);
  await assert.rejects(running, failure);
  assert.ok(f.actions.includes('supervisor_stopped'));
  assert.equal(f.actions.at(-1), 'clients_closed');
});

test('closes the relay and clients when the listener cannot bind', async () => {
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
  const address = occupied.address();
  assert.ok(address !== null && typeof address !== 'string');
  const f = fixture();
  try {
    const config = configuration();
    assert.ok(config.terminal);
    await assert.rejects(
      runGatewayRuntime(
        { ...config, terminal: { ...config.terminal, listenPort: address.port } },
        new AbortController().signal,
        f.dependencies,
      ),
      { code: 'EADDRINUSE' },
    );
    assert.ok(f.actions.includes('relay_closed'));
    assert.equal(f.actions.at(-1), 'clients_closed');
    assert.equal(
      f.events.some((event) => event.type === 'service_started'),
      false,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

test('does not create AWS clients after startup cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture();
  await assert.rejects(runGatewayRuntime(configuration(), controller.signal, f.dependencies), { name: 'AbortError' });
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.events, []);
});

test('cancels a pending listener bind without starting recording or leaking the server', async () => {
  const controller = new AbortController();
  const f = fixture();
  const running = runGatewayRuntime(configuration(), controller.signal, f.dependencies);
  controller.abort();
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.supervisorRuns(), 0);
  assert.equal(f.server()?.listening, false);
  assert.ok(f.actions.includes('relay_closed'));
  assert.equal(f.actions.at(-1), 'clients_closed');
});

test('ignores reporting failures', async () => {
  const controller = new AbortController();
  const f = fixture(async () => controller.abort());
  f.dependencies.report = () => {
    throw new Error('logger failed');
  };
  await runGatewayRuntime(configuration(), controller.signal, f.dependencies);
  assert.equal(f.actions.at(-1), 'clients_closed');
});
