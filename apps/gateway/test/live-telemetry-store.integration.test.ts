import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import {
  commandId,
  initialCommandParser,
  type CommandEvidence,
} from '../../../packages/contracts/private/command-evidence.js';
import type { MonitorEvidencePage } from '../../../packages/contracts/private/monitor-evidence.js';
import {
  monitorLiveTelemetryKey,
  type MonitorLiveTelemetry,
} from '../../../packages/contracts/private/live-telemetry.js';
import { terminalInputKey } from '../../../packages/contracts/private/terminal-access.js';
import {
  DynamoGatewayLiveTelemetryStore,
  GatewayLiveTelemetryError,
  type GatewayLiveTelemetryBinding,
} from '../src/live-telemetry-store.js';
import type { StoredMonitorChunk } from '../src/monitor-chunk-store.js';
import { DynamoMonitorRecordingStore } from '../src/monitor-recording-store.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

const startedAt = '2026-10-13T00:00:01.000Z';
const connectionId = 'browser-connection-1';

interface Fixture {
  client: DynamoDBDocumentClient;
  table: string;
  sessionId: string;
  monitorSource: string;
  terminalSource: string;
  binding: GatewayLiveTelemetryBinding;
  recorder: DynamoMonitorRecordingStore;
  telemetry: DynamoGatewayLiveTelemetryStore;
  lease: { sessionId: string; recorderId: string; generation: number };
  put(key: { PK: string; SK: string }, data: unknown): Promise<unknown>;
}

function at(seconds: number): string {
  return new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();
}

function reference(f: Fixture, afterSequence: number, nextSequence: number): StoredMonitorChunk {
  const sha256 = String.fromCharCode(97 + nextSequence).repeat(64);
  return {
    phase: 'live',
    objectKey:
      `sessions/${f.sessionId}/metrics/000000001/live/${f.monitorSource}/` +
      `${String(afterSequence + 1).padStart(6, '0')}-${String(nextSequence).padStart(6, '0')}-${sha256}.json`,
    sha256,
    source: f.monitorSource,
    after: afterSequence,
    nextSequence,
    frameCount: nextSequence - afterSequence,
  };
}

function live(f: Fixture, sequence: number, frontier = sequence): MonitorLiveTelemetry {
  const recordedAt = at(sequence);
  return {
    schemaVersion: 1,
    sessionId: f.sessionId,
    startedAt,
    source: f.monitorSource,
    frontier,
    sequence,
    recordedAt,
    metric: {
      type: 'metrics',
      sample: { at: recordedAt, values: { request_rate: sequence * 10, error_rate: 1 / sequence } },
      counters: { totalRequests: sequence * 10, failedRequests: sequence },
      recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    },
  };
}

function monitorEvidence(f: Fixture, afterSequence: number, sequence: number): MonitorEvidencePage {
  const recordedAt = at(sequence);
  return {
    schemaVersion: 1,
    source: f.monitorSource,
    after: afterSequence,
    nextSequence: sequence,
    events: [
      {
        sequence,
        recordedAt,
        event: {
          id: `${f.monitorSource}:${sequence}`,
          at: recordedAt,
          kind: 'monitor',
          signal: sequence === 1 ? 'outage_started' : 'recovery_sustaining',
          label: 'Checkout availability',
        },
      },
    ],
  };
}

function command(f: Fixture, sequence: number): CommandEvidence {
  return {
    id: commandId(f.terminalSource, sequence),
    at: at(sequence + 2),
    kind: 'command',
    seq: sequence,
    endedAt: at(sequence + 2),
    command: `command-${sequence}`,
    exitStatus: 0,
    source: 'learner',
    changedFiles: [],
    outputExcerpt: '',
    outputTruncated: false,
    metrics: null,
  };
}

async function setParser(f: Fixture, count: number): Promise<void> {
  await f.put(
    { PK: `SESSION#${f.sessionId}`, SK: 'COMMAND_PARSER' },
    { ...initialCommandParser(f.terminalSource), cursor: count, count },
  );
}

async function fixture(): Promise<Fixture> {
  const table = `test-${randomUUID()}`;
  const sessionId = randomUUID();
  const monitorSource = randomUUID();
  const terminalSource = randomUUID();
  await database.client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    }),
  );
  const put = (key: { PK: string; SK: string }, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key, data } }));
  await put(
    { PK: `SESSION#${sessionId}`, SK: 'STATE' },
    { view: { status: 'provisioning', recording: { status: 'pending', reason: null } } },
  );
  const recorder = new DynamoMonitorRecordingStore(database.document, table);
  const claimed = await recorder.claim({
    sessionId,
    recorderId: 'recorder-gateway-a',
    now: '2026-10-13T00:00:00.000Z',
    leaseDurationMs: 60_000,
  });
  await recorder.begin(claimed.lease, startedAt, startedAt);
  const result: Fixture = {
    client: database.document,
    table,
    sessionId,
    monitorSource,
    terminalSource,
    binding: { sessionId, connectionId, generation: 1 },
    recorder,
    telemetry: new DynamoGatewayLiveTelemetryStore(database.document, table),
    lease: claimed.lease,
    put,
  };
  await Promise.all([
    put(
      { PK: `SESSION#${sessionId}`, SK: 'STATE' },
      {
        view: {
          id: sessionId,
          status: 'ready',
          statusReason: null,
          readyAt: startedAt,
          recording: { status: 'recording', reason: null },
        },
      },
    ),
    put(terminalInputKey(sessionId), {
      schemaVersion: 1,
      sessionId,
      generation: 1,
      connectionId,
      claimedAt: startedAt,
    }),
  ]);
  await setParser(result, 1);
  await put({ PK: `SESSION#${sessionId}`, SK: 'COMMAND#000001' }, command(result, 1));
  await recorder.append(
    claimed.lease,
    startedAt,
    reference(result, 0, 1),
    at(1),
    undefined,
    undefined,
    monitorEvidence(result, 0, 1),
    live(result, 1),
  );
  return result;
}

function telemetryError(code: GatewayLiveTelemetryError['code']): (error: unknown) => boolean {
  return (error) => error instanceof GatewayLiveTelemetryError && error.code === code;
}

test('recorder Gateway A publishes telemetry that browser Gateway B reads as bounded deltas', async () => {
  const f = await fixture();
  const attached = await f.telemetry.read(f.binding);
  assert.equal(attached.type, 'telemetry');
  if (attached.type !== 'telemetry') return;
  assert.deepEqual(attached.metric, live(f, 1).metric);
  assert.deepEqual(attached.events, []);
  assert.deepEqual(attached.cursor, {
    startedAt,
    source: f.monitorSource,
    monitorSequence: 1,
    commandSequence: 1,
    metricSequence: 1,
  });

  await f.put({ PK: `SESSION#${f.sessionId}`, SK: 'COMMAND#000002' }, command(f, 2));
  await setParser(f, 2);
  await f.recorder.append(
    f.lease,
    startedAt,
    reference(f, 1, 2),
    at(2),
    undefined,
    undefined,
    monitorEvidence(f, 1, 2),
    live(f, 2),
  );

  const delta = await f.telemetry.read(f.binding, attached.cursor);
  assert.equal(delta.type, 'telemetry');
  if (delta.type !== 'telemetry') return;
  assert.deepEqual(delta.metric, live(f, 2).metric);
  assert.deepEqual(
    delta.events.map((event) => [event.kind, event.id]),
    [
      ['monitor', `${f.monitorSource}:2`],
      ['command', commandId(f.terminalSource, 2)],
    ],
  );
  assert.deepEqual(delta.cursor, {
    startedAt,
    source: f.monitorSource,
    monitorSequence: 2,
    commandSequence: 2,
    metricSequence: 2,
  });

  const empty = await f.telemetry.read(f.binding, delta.cursor);
  assert.deepEqual(empty, { type: 'telemetry', cursor: delta.cursor, metric: null, events: [] });
});

test('live telemetry pages command deltas without dropping the remaining commands', async () => {
  const f = await fixture();
  const attached = await f.telemetry.read(f.binding);
  assert.equal(attached.type, 'telemetry');
  if (attached.type !== 'telemetry') return;
  for (let sequence = 2; sequence <= 22; sequence++) {
    await f.put(
      { PK: `SESSION#${f.sessionId}`, SK: `COMMAND#${String(sequence).padStart(6, '0')}` },
      command(f, sequence),
    );
  }
  await setParser(f, 22);

  const first = await f.telemetry.read(f.binding, attached.cursor);
  assert.equal(first.type, 'telemetry');
  if (first.type !== 'telemetry') return;
  assert.equal(first.events.length, 20);
  assert.deepEqual(
    first.events.map((event) => (event.kind === 'command' ? event.seq : null)),
    Array.from({ length: 20 }, (_, index) => index + 2),
  );
  assert.equal(first.cursor.commandSequence, 21);

  const second = await f.telemetry.read(f.binding, first.cursor);
  assert.equal(second.type, 'telemetry');
  if (second.type !== 'telemetry') return;
  assert.deepEqual(
    second.events.map((event) => (event.kind === 'command' ? event.seq : null)),
    [22],
  );
  assert.equal(second.cursor.commandSequence, 22);
});

test('live telemetry fails closed for replaced input and stops at a terminal outcome', async () => {
  const f = await fixture();
  const attached = await f.telemetry.read(f.binding);
  assert.equal(attached.type, 'telemetry');
  await f.put(terminalInputKey(f.sessionId), {
    schemaVersion: 1,
    sessionId: f.sessionId,
    generation: 2,
    connectionId: 'browser-connection-2',
    claimedAt: at(2),
  });
  await assert.rejects(f.telemetry.read(f.binding), telemetryError('replaced'));

  await f.put(terminalInputKey(f.sessionId), {
    schemaVersion: 1,
    sessionId: f.sessionId,
    generation: 1,
    connectionId,
    claimedAt: startedAt,
  });
  await f.put(
    { PK: `SESSION#${f.sessionId}`, SK: 'STATE' },
    {
      view: {
        id: f.sessionId,
        status: 'resolved',
        statusReason: 'validators_passed',
        readyAt: startedAt,
        recording: { status: 'draining', reason: null },
      },
    },
  );
  assert.deepEqual(await f.telemetry.read(f.binding), {
    type: 'terminal',
    status: 'resolved',
    reason: 'validators_passed',
  });
});

test('live telemetry distinguishes invalid durable data, authorization failure, and cancellation', async () => {
  const f = await fixture();
  const attached = await f.telemetry.read(f.binding);
  assert.equal(attached.type, 'telemetry');
  if (attached.type !== 'telemetry') return;
  await assert.rejects(
    f.telemetry.read(f.binding, {
      ...attached.cursor,
      source: randomUUID(),
    }),
    telemetryError('telemetry_unavailable'),
  );
  await assert.rejects(
    f.telemetry.read(f.binding, {
      ...attached.cursor,
      monitorSequence: attached.cursor.monitorSequence + 1,
    }),
    telemetryError('telemetry_unavailable'),
  );

  await f.put(monitorLiveTelemetryKey(f.sessionId), { ...live(f, 1), frontier: 2 });
  await assert.rejects(f.telemetry.read(f.binding), telemetryError('telemetry_unavailable'));

  await f.put(
    { PK: `SESSION#${f.sessionId}`, SK: 'STATE' },
    { view: { id: f.sessionId, status: 'ready', statusReason: null, readyAt: null } },
  );
  await assert.rejects(f.telemetry.read(f.binding), telemetryError('authorization_failed'));

  const controller = new AbortController();
  controller.abort(new Error('closed'));
  await assert.rejects(f.telemetry.read(f.binding, undefined, controller.signal), telemetryError('cancelled'));
});
