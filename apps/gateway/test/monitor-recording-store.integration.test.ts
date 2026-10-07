import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { MonitorFrame, MonitorMetricFrame } from '../src/monitor-client.js';
import type { StoredMonitorChunk } from '../src/monitor-chunk-store.js';
import {
  DynamoMonitorRecordingStore,
  MonitorRecordingStoreError,
  type MonitorRecorderLease,
  type MonitorRecordingState,
} from '../src/monitor-recording-store.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

const now = '2026-10-07T00:00:00.000Z';
const startedAt = '2026-10-07T00:00:01.000Z';
const source = '22222222-2222-4222-8222-222222222222';

interface Fixture {
  sessionId: string;
  table: string;
  store: DynamoMonitorRecordingStore;
  get(key: { PK: string; SK: string }): Promise<Record<string, unknown> | undefined>;
  put(key: { PK: string; SK: string }, data: unknown): Promise<unknown>;
  rows(): Promise<Record<string, unknown>[]>;
}

async function fixture(): Promise<Fixture> {
  const table = `test-${randomUUID()}`;
  const sessionId = randomUUID();
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
  const get = async (key: { PK: string; SK: string }) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item?.data as
      Record<string, unknown> | undefined;
  const rows = async () =>
    ((await database.document.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? []) as Record<
      string,
      unknown
    >[];
  await put(
    { PK: `SESSION#${sessionId}`, SK: 'STATE' },
    { view: { status: 'provisioning', recording: { status: 'pending', reason: null } } },
  );
  return { sessionId, table, store: new DynamoMonitorRecordingStore(database.document, table), get, put, rows };
}

function metric(at: string): MonitorMetricFrame {
  return {
    type: 'metrics',
    sample: { at, values: { request_rate: 1 } },
    counters: { totalRequests: 1, failedRequests: 0 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
}

function frame(sequence = 1): MonitorFrame {
  const recordedAt = `2026-10-07T00:00:0${sequence}.000Z`;
  return { source, sequence, recordedAt, payload: metric(recordedAt) };
}

function reference(
  sessionId: string,
  generation: number,
  phase: 'live' | 'sealed',
  after = 0,
  nextSequence = 1,
): StoredMonitorChunk {
  const frameCount = phase === 'live' ? nextSequence - after : nextSequence;
  const first = frameCount === 0 ? 0 : after + 1;
  const sha256 = (phase === 'live' ? 'a' : 'b').repeat(64);
  const frameSource = frameCount === 0 ? null : source;
  return {
    phase,
    objectKey:
      `sessions/${sessionId}/metrics/${String(generation).padStart(9, '0')}/${phase}/${frameSource ?? 'empty'}/` +
      `${String(first).padStart(6, '0')}-${String(nextSequence).padStart(6, '0')}-${sha256}.json`,
    sha256,
    source: frameSource,
    after,
    nextSequence,
    frameCount,
  };
}

function storeError(code: MonitorRecordingStoreError['code']): (error: unknown) => boolean {
  return (error) => error instanceof MonitorRecordingStoreError && error.code === code;
}

async function claim(f: Fixture, recorderId = 'gateway-1', at = now) {
  return f.store.claim({ sessionId: f.sessionId, recorderId, now: at, leaseDurationMs: 5_000 });
}

async function setDraining(
  f: Fixture,
  lease: MonitorRecorderLease,
  cutoffAt = '2026-10-07T00:00:03.000Z',
  drainDeadlineAt = '2026-10-07T00:00:20.000Z',
): Promise<MonitorRecordingState> {
  const state = await f.store.get(f.sessionId);
  assert.ok(state);
  assert.deepEqual(
    { recorderId: state.recorderId, generation: state.generation },
    { recorderId: lease.recorderId, generation: lease.generation },
  );
  const draining: MonitorRecordingState = { ...state, status: 'draining', cutoffAt, drainDeadlineAt };
  await Promise.all([
    f.put({ PK: `SESSION#${f.sessionId}`, SK: 'RECORDING' }, draining),
    f.put(
      { PK: `SESSION#${f.sessionId}`, SK: 'STATE' },
      { view: { status: 'resolved', recording: { status: 'draining', reason: null } } },
    ),
  ]);
  return draining;
}

async function publicRecording(f: Fixture): Promise<{ status: string; reason: string | null }> {
  const session = await f.get({ PK: `SESSION#${f.sessionId}`, SK: 'STATE' });
  assert.ok(session);
  const view = session.view as { recording: { status: string; reason: string | null } };
  return view.recording;
}

async function setTerminalSession(f: Fixture, recordingStatus: 'recording' | 'draining'): Promise<void> {
  await f.put(
    { PK: `SESSION#${f.sessionId}`, SK: 'STATE' },
    { view: { status: 'error', statusReason: 'start_failed', recording: { status: recordingStatus, reason: null } } },
  );
}

test('claims a session, saves a start, and atomically advances a chunk cursor', async () => {
  const f = await fixture();
  const claimed = await claim(f);

  assert.deepEqual(claimed.lease, { sessionId: f.sessionId, recorderId: 'gateway-1', generation: 1 });
  assert.equal(claimed.state.leaseExpiresAt, '2026-10-07T00:00:05.000Z');
  assert.deepEqual(claimed.state, await f.store.get(f.sessionId));
  assert.equal(
    (
      (await f.get({ PK: `SESSION#${f.sessionId}`, SK: 'STATE' }))!.view as Record<string, unknown> as {
        recording: { status: string };
      }
    ).recording.status,
    'recording',
  );

  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  const page = reference(f.sessionId, 1, 'live');
  await f.store.append(claimed.lease, startedAt, page, '2026-10-07T00:00:01.500Z');
  await f.store.append(claimed.lease, startedAt, page, '2026-10-07T00:00:01.500Z');

  const saved = await f.store.get(f.sessionId);
  assert.equal(saved?.startedAt, startedAt);
  assert.equal(saved?.source, source);
  assert.equal(saved?.cursor, 1);
  const chunks = (await f.rows()).filter((row) => String(row.SK).startsWith('CHUNK#'));
  assert.equal(chunks.length, 1);
  assert.deepEqual((chunks[0]!.data as { reference: unknown }).reference, page);
});

test('allows only one concurrent recorder claim', async () => {
  const f = await fixture();
  const attempts = await Promise.allSettled([claim(f, 'gateway-a'), claim(f, 'gateway-b')]);
  const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
  const rejected = attempts.filter((result) => result.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(storeError('lease_unavailable')((rejected[0] as PromiseRejectedResult).reason));
  assert.equal((await f.store.get(f.sessionId))?.generation, 1);
});

test('recovers a recorder claim whose transaction response was lost', async () => {
  const f = await fixture();
  let lost = false;
  const uncertain = new DynamoMonitorRecordingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand && !lost) {
          lost = true;
          throw new Error('Claim response lost');
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );

  const claimed = await uncertain.claim({
    sessionId: f.sessionId,
    recorderId: 'gateway-1',
    now,
    leaseDurationMs: 5_000,
  });

  assert.equal(lost, true);
  assert.equal(claimed.lease.generation, 1);
  assert.equal((await f.store.get(f.sessionId))?.recorderId, 'gateway-1');
});

test('fences an expired recorder and resumes its durable checkpoint with a new generation', async () => {
  const f = await fixture();
  const first = await claim(f, 'gateway-a');
  await f.store.begin(first.lease, startedAt, '2026-10-07T00:00:00.500Z');
  await f.store.append(first.lease, startedAt, reference(f.sessionId, 1, 'live'), '2026-10-07T00:00:01.000Z');

  const replacement = await claim(f, 'gateway-b', '2026-10-07T00:00:05.000Z');

  assert.equal(replacement.lease.generation, 2);
  assert.deepEqual(
    {
      startedAt: replacement.state.startedAt,
      source: replacement.state.source,
      cursor: replacement.state.cursor,
    },
    { startedAt, source, cursor: 1 },
  );
  await assert.rejects(
    f.store.append(first.lease, startedAt, reference(f.sessionId, 1, 'live', 1, 2), '2026-10-07T00:00:05.500Z'),
    storeError('stale_lease'),
  );
  await f.store.append(
    replacement.lease,
    startedAt,
    reference(f.sessionId, 2, 'live', 1, 2),
    '2026-10-07T00:00:05.500Z',
  );
  assert.equal((await f.store.get(f.sessionId))?.cursor, 2);
});

test('renews only the current unexpired generation', async () => {
  const f = await fixture();
  const claimed = await claim(f);

  const renewed = await f.store.renew(claimed.lease, '2026-10-07T00:00:04.000Z', 10_000);
  assert.equal(renewed.leaseExpiresAt, '2026-10-07T00:00:14.000Z');
  const notShortened = await f.store.renew(claimed.lease, '2026-10-07T00:00:05.000Z', 5_000);
  assert.equal(notShortened.leaseExpiresAt, '2026-10-07T00:00:14.000Z');
  await assert.rejects(
    f.store.renew({ ...claimed.lease, generation: 2 }, '2026-10-07T00:00:05.000Z'),
    storeError('stale_lease'),
  );
  await assert.rejects(f.store.renew(claimed.lease, '2026-10-07T00:00:14.000Z'), storeError('stale_lease'));
});

test('recovers an append whose DynamoDB response was lost', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  let lost = false;
  const uncertain = new DynamoMonitorRecordingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand && !lost) {
          lost = true;
          throw new Error('Commit response lost');
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );

  await uncertain.append(claimed.lease, startedAt, reference(f.sessionId, 1, 'live'), '2026-10-07T00:00:01.000Z');

  assert.equal(lost, true);
  assert.equal((await f.store.get(f.sessionId))?.cursor, 1);
});

test('recognizes an append committed before a concurrent drain transition', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  let lost = false;
  const uncertain = new DynamoMonitorRecordingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand && !lost) {
          lost = true;
          await setDraining(f, claimed.lease);
          throw new Error('Commit response lost during drain transition');
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );

  await uncertain.append(claimed.lease, startedAt, reference(f.sessionId, 1, 'live'), '2026-10-07T00:00:02.000Z');

  const saved = await f.store.get(f.sessionId);
  assert.equal(lost, true);
  assert.equal(saved?.status, 'draining');
  assert.equal(saved?.cursor, 1);
  assert.equal((await f.rows()).filter((row) => String(row.SK).startsWith('CHUNK#')).length, 1);
});

test('rejects a missing sequence range without publishing its chunk reference', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');

  await assert.rejects(
    f.store.append(claimed.lease, startedAt, reference(f.sessionId, 1, 'live', 1, 2), '2026-10-07T00:00:01.000Z'),
    storeError('invalid_state'),
  );

  assert.equal((await f.store.get(f.sessionId))?.cursor, 0);
  assert.equal((await f.rows()).filter((row) => String(row.SK).startsWith('CHUNK#')).length, 0);
});

test('reports an append that loses the race with the drain transition', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  await setDraining(f, claimed.lease);

  await assert.rejects(
    f.store.append(claimed.lease, startedAt, reference(f.sessionId, 1, 'live'), '2026-10-07T00:00:04.000Z'),
    storeError('recording_draining'),
  );
  await assert.rejects(
    f.store.append(claimed.lease, startedAt, reference(f.sessionId, 1, 'live'), '2026-10-07T00:00:05.000Z'),
    storeError('stale_lease'),
  );

  assert.equal((await f.store.get(f.sessionId))?.cursor, 0);
  assert.equal((await f.rows()).filter((row) => String(row.SK).startsWith('CHUNK#')).length, 0);
});

test('caps a draining lease at the fixed drain deadline', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  await setDraining(f, claimed.lease, '2026-10-07T00:00:03.000Z', '2026-10-07T00:00:20.000Z');

  const renewed = await f.store.renew(claimed.lease, '2026-10-07T00:00:04.000Z', 60_000);

  assert.equal(renewed.leaseExpiresAt, '2026-10-07T00:00:20.000Z');
});

test('publishes one canonical sealed reference and makes retries idempotent', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  await f.store.append(claimed.lease, startedAt, reference(f.sessionId, 1, 'live'), '2026-10-07T00:00:01.500Z');
  const cutoffAt = '2026-10-07T00:00:03.000Z';
  await setDraining(f, claimed.lease, cutoffAt);
  const sealed = {
    startedAt,
    cutoffAt,
    source,
    cursor: 1,
    frames: [frame()],
    final: metric(cutoffAt),
  };
  const canonical = reference(f.sessionId, 1, 'sealed');

  let lost = false;
  const uncertain = new DynamoMonitorRecordingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand && !lost) {
          lost = true;
          throw new Error('Seal response lost');
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );
  await uncertain.seal(claimed.lease, sealed, canonical, '2026-10-07T00:00:04.000Z');
  await f.store.seal(claimed.lease, sealed, canonical, '2026-10-07T00:00:04.000Z');

  assert.equal(lost, true);
  const saved = await f.store.get(f.sessionId);
  assert.equal(saved?.status, 'complete');
  assert.equal(saved?.recorderId, null);
  assert.equal(saved?.leaseExpiresAt, null);
  assert.deepEqual(saved?.sealed, canonical);
  assert.equal(
    (
      (await f.get({ PK: `SESSION#${f.sessionId}`, SK: 'STATE' }))!.view as Record<string, unknown> as {
        recording: { status: string };
      }
    ).recording.status,
    'complete',
  );
  await assert.rejects(
    f.store.markIncomplete(f.sessionId, 'task_lost', '2026-10-07T00:00:05.000Z'),
    storeError('invalid_state'),
  );
});

test('marks a claimed recording incomplete after session start fails', async () => {
  const f = await fixture();
  await claim(f);
  await setTerminalSession(f, 'recording');
  const completedAt = '2026-10-07T00:00:02.000Z';

  await f.store.markIncomplete(f.sessionId, 'task_lost', completedAt);

  assert.deepEqual(await publicRecording(f), { status: 'incomplete', reason: 'task_lost' });
  assert.deepEqual(await f.store.get(f.sessionId), {
    schemaVersion: 1,
    status: 'incomplete',
    recorderId: null,
    generation: 1,
    leaseExpiresAt: null,
    startedAt: null,
    source: null,
    cursor: 0,
    cutoffAt: completedAt,
    drainDeadlineAt: completedAt,
    sealed: null,
    reason: 'task_lost',
    updatedAt: completedAt,
    completedAt,
  });
});

test('marks an expired drain incomplete and preserves its fixed bounds', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  const cutoffAt = '2026-10-07T00:00:03.000Z';
  const drainDeadlineAt = '2026-10-07T00:00:20.000Z';
  await setDraining(f, claimed.lease, cutoffAt, drainDeadlineAt);

  await assert.rejects(
    f.store.markIncomplete(f.sessionId, 'drain_timeout', '2026-10-07T00:00:19.999Z'),
    storeError('invalid_state'),
  );
  await f.store.markIncomplete(f.sessionId, 'drain_timeout', drainDeadlineAt);

  const saved = await f.store.get(f.sessionId);
  assert.equal(saved?.status, 'incomplete');
  assert.equal(saved?.cutoffAt, cutoffAt);
  assert.equal(saved?.drainDeadlineAt, drainDeadlineAt);
  assert.equal(saved?.completedAt, drainDeadlineAt);
  assert.equal(saved?.reason, 'drain_timeout');
  assert.deepEqual(await publicRecording(f), { status: 'incomplete', reason: 'drain_timeout' });
});

test('recovers an incomplete transition whose transaction response was lost and accepts an exact retry', async () => {
  const f = await fixture();
  await claim(f);
  await setTerminalSession(f, 'recording');
  let lost = false;
  const uncertain = new DynamoMonitorRecordingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand && !lost) {
          lost = true;
          throw new Error('Incomplete response lost');
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );

  await uncertain.markIncomplete(f.sessionId, 'task_lost', '2026-10-07T00:00:02.000Z');
  await f.store.markIncomplete(f.sessionId, 'task_lost', '2026-10-07T00:00:03.000Z');

  assert.equal(lost, true);
  assert.equal((await f.store.get(f.sessionId))?.completedAt, '2026-10-07T00:00:02.000Z');
  await assert.rejects(
    f.store.markIncomplete(f.sessionId, 'recorder_lost', '2026-10-07T00:00:03.000Z'),
    storeError('invalid_state'),
  );
});

test('allows only one terminal recording result when seal and incomplete race', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  const cutoffAt = '2026-10-07T00:00:03.000Z';
  await setDraining(f, claimed.lease, cutoffAt);
  const sealed = {
    startedAt,
    cutoffAt,
    source: null,
    cursor: 0,
    frames: [],
    final: metric(cutoffAt),
  };

  const attempts = await Promise.allSettled([
    f.store.seal(claimed.lease, sealed, reference(f.sessionId, 1, 'sealed', 0, 0), '2026-10-07T00:00:04.000Z'),
    f.store.markIncomplete(f.sessionId, 'task_lost', '2026-10-07T00:00:04.000Z'),
  ]);

  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
  const saved = await f.store.get(f.sessionId);
  const published = await publicRecording(f);
  assert.ok(saved?.status === 'complete' || saved?.status === 'incomplete');
  assert.equal(published.status, saved.status);
  assert.equal(published.reason, saved.reason);
});

test('does not mark active or publicly inconsistent sessions incomplete', async () => {
  const active = await fixture();
  await claim(active);

  await assert.rejects(
    active.store.markIncomplete(active.sessionId, 'task_lost', '2026-10-07T00:00:02.000Z'),
    storeError('invalid_state'),
  );
  assert.equal((await active.store.get(active.sessionId))?.status, 'recording');
  assert.deepEqual(await publicRecording(active), { status: 'recording', reason: null });

  const inconsistent = await fixture();
  await claim(inconsistent);
  await inconsistent.put(
    { PK: `SESSION#${inconsistent.sessionId}`, SK: 'STATE' },
    { view: { status: 'error', recording: { status: 'pending', reason: null } } },
  );
  await assert.rejects(
    inconsistent.store.markIncomplete(inconsistent.sessionId, 'task_lost', '2026-10-07T00:00:02.000Z'),
    storeError('invalid_state'),
  );
  assert.equal((await inconsistent.store.get(inconsistent.sessionId))?.status, 'recording');
  assert.deepEqual(await publicRecording(inconsistent), { status: 'pending', reason: null });
});

test('rejects early, expired, and stale sealing attempts', async () => {
  const f = await fixture();
  const claimed = await claim(f);
  await f.store.begin(claimed.lease, startedAt, '2026-10-07T00:00:00.500Z');
  const cutoffAt = '2026-10-07T00:00:03.000Z';
  const sealed = {
    startedAt,
    cutoffAt,
    source: null,
    cursor: 0,
    frames: [],
    final: metric(cutoffAt),
  };
  const canonical = reference(f.sessionId, 1, 'sealed', 0, 0);

  await assert.rejects(
    f.store.seal(claimed.lease, sealed, canonical, '2026-10-07T00:00:03.500Z'),
    storeError('invalid_state'),
  );
  await setDraining(f, claimed.lease, cutoffAt, '2026-10-07T00:00:04.000Z');
  await assert.rejects(
    f.store.seal(claimed.lease, sealed, canonical, '2026-10-07T00:00:02.500Z'),
    storeError('invalid_input'),
  );
  await assert.rejects(
    f.store.seal(claimed.lease, sealed, canonical, '2026-10-07T00:00:04.000Z'),
    storeError('invalid_state'),
  );
  await assert.rejects(
    f.store.seal({ ...claimed.lease, recorderId: 'gateway-other' }, sealed, canonical, '2026-10-07T00:00:03.500Z'),
    storeError('stale_lease'),
  );
});

test('rejects claims for missing sessions and invalid persisted recording data', async () => {
  const f = await fixture();
  const missing = randomUUID();
  await assert.rejects(
    f.store.claim({ sessionId: missing, recorderId: 'gateway-1', now }),
    storeError('invalid_state'),
  );
  await f.put({ PK: `SESSION#${f.sessionId}`, SK: 'RECORDING' }, { schemaVersion: 99 });
  await assert.rejects(f.store.get(f.sessionId), storeError('invalid_store'));
});
