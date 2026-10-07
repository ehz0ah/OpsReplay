import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GatewayAwsClients } from '../src/aws.js';
import {
  createGatewayRecorderId,
  loadGatewayRecordingRuntimeConfiguration,
  runGatewayRecordingRuntime,
  type GatewayRecordingRuntimeDependencies,
  type GatewayRecordingRuntimeEvent,
} from '../src/recording-runtime.js';

const validEnvironment = {
  SESSION_TABLE_NAME: 'opsreplay-sessions',
  RECORDING_BUCKET_NAME: 'opsreplay-recordings',
  MAXIMUM_CONCURRENT_RECORDINGS: '16',
  MONITOR_PORT: '9443',
};

test('loads the complete bounded recording runtime configuration', () => {
  assert.deepEqual(loadGatewayRecordingRuntimeConfiguration(validEnvironment), {
    sessionTableName: 'opsreplay-sessions',
    recordingBucketName: 'opsreplay-recordings',
    maximumConcurrentRecordings: 16,
    monitorPort: 9443,
  });
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
] as const) {
  test(`rejects invalid ${name}`, () => {
    assert.throws(
      () => loadGatewayRecordingRuntimeConfiguration({ ...validEnvironment, [name]: value }),
      new RegExp(`${name} is invalid`),
    );
  });
}

function fixture(run: (signal: AbortSignal) => Promise<void>) {
  let closed = 0;
  let options: Record<string, unknown> | undefined;
  const events: GatewayRecordingRuntimeEvent[] = [];
  const clients = { close: () => closed++ } as unknown as GatewayAwsClients;
  const dependencies: GatewayRecordingRuntimeDependencies = {
    createClients: () => clients,
    createRecorderId: () => 'gateway-test',
    createSupervisor: (value, actualClients) => {
      assert.equal(actualClients, clients);
      options = value as unknown as Record<string, unknown>;
      return { run };
    },
    report: (event) => events.push(event),
  };
  return { dependencies, events, closed: () => closed, options: () => options };
}

test('runs one supervisor and always closes shared AWS clients', async () => {
  const controller = new AbortController();
  const f = fixture(async (signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
  });
  await runGatewayRecordingRuntime(
    loadGatewayRecordingRuntimeConfiguration(validEnvironment),
    controller.signal,
    f.dependencies,
  );
  assert.equal(f.closed(), 1);
  assert.equal(f.options()?.recorderId, 'gateway-test');
  assert.equal(f.options()?.maximumConcurrentRecordings, 16);
  assert.deepEqual(f.events, [
    { type: 'service_started', recorderId: 'gateway-test', maximumConcurrentRecordings: 16 },
    { type: 'service_stopped', recorderId: 'gateway-test' },
  ]);
});

test('closes AWS clients and preserves a fatal supervisor failure', async () => {
  const failure = new Error('fatal');
  const f = fixture(async () => {
    throw failure;
  });
  await assert.rejects(
    runGatewayRecordingRuntime(
      loadGatewayRecordingRuntimeConfiguration(validEnvironment),
      new AbortController().signal,
      f.dependencies,
    ),
    failure,
  );
  assert.equal(f.closed(), 1);
  assert.equal(f.events.at(-1)?.type, 'service_stopped');
});

test('does not create AWS clients after startup cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture(async () => {});
  await assert.rejects(
    runGatewayRecordingRuntime(
      loadGatewayRecordingRuntimeConfiguration(validEnvironment),
      controller.signal,
      f.dependencies,
    ),
    { name: 'AbortError' },
  );
  assert.equal(f.closed(), 0);
  assert.deepEqual(f.events, []);
});

test('ignores reporting failures', async () => {
  const controller = new AbortController();
  const f = fixture(async () => controller.abort());
  f.dependencies.report = () => {
    throw new Error('logger failed');
  };
  await runGatewayRecordingRuntime(
    loadGatewayRecordingRuntimeConfiguration(validEnvironment),
    controller.signal,
    f.dependencies,
  );
  assert.equal(f.closed(), 1);
});
