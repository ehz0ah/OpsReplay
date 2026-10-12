import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoFinaliseStore } from '../../../packages/session/src/finalise-store.js';
import { createFinaliseSession } from '../../../packages/session/src/finalise.js';
import { deriveDebrief, type DebriefManifest } from '../../../packages/session/src/debrief.js';
import { initialSessionLifecycle } from '../../../packages/contracts/private/session-lifecycle.js';
import { recordingRetainUntil } from '../../../packages/contracts/private/recording-retention.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { sessionRecord } from './session-fixture.js';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60000 },
);
after(() => database?.close());
const at = '2026-10-12T00:00:00.000Z';
const end = '2026-10-12T00:01:00.000Z';
const manifest = JSON.parse(
  readFileSync(new URL('../../../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
) as DebriefManifest;
async function fixture(error = false) {
  const table = `test-${randomUUID()}`;
  const id = randomUUID();
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
  const session = sessionRecord(id);
  Object.assign(session.view, {
    status: error ? 'error' : 'ended',
    statusReason: error ? 'environment_exited' : 'learner_ended',
    readyAt: at,
    endsAt: '2026-10-12T00:20:00.000Z',
    endedAt: end,
    recording: { status: 'incomplete', reason: 'data_gap' },
  });
  const key = (SK: string) => ({ PK: `SESSION#${id}`, SK });
  const put = (SK: string, data: unknown) =>
    database.document.send(
      new PutCommand({ TableName: table, Item: { ...key(SK), data, WorkPK: 'LIFECYCLE', WorkSK: at } }),
    );
  const get = async (SK: string) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: key(SK), ConsistentRead: true }))).Item;
  const lifecycle = {
    ...initialSessionLifecycle(id, at),
    readyAt: at,
    terminalSource: randomUUID(),
    lastSeenAt: at,
    lastMonitorAt: at,
    drainDeadlineAt: '2026-10-12T00:01:30.000Z',
    recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
    taskStoppedAt: end,
    schedulesDeleted: true,
  };
  await put('STATE', session);
  await put('LIFECYCLE', lifecycle);
  await put('RECORDING', {
    schemaVersion: 1,
    status: 'incomplete',
    recorderId: null,
    generation: 1,
    leaseExpiresAt: null,
    startedAt: at,
    source: null,
    cursor: 0,
    cutoffAt: end,
    drainDeadlineAt: lifecycle.drainDeadlineAt,
    sealed: null,
    retainUntil: recordingRetainUntil(at, 'provisional'),
    reason: 'data_gap',
    updatedAt: end,
    completedAt: end,
  });
  const user = (SK: string) => ({ PK: `USER#${session.ownerId}`, SK });
  await database.document.send(
    new PutCommand({ TableName: table, Item: { ...user('ACTIVE'), data: { sessionId: id, requestId: randomUUID() } } }),
  );
  const progress = async () =>
    (
      await database.document.send(
        new GetCommand({ TableName: table, Key: user('PROGRESS#wrong-upstream-port'), ConsistentRead: true }),
      )
    ).Item?.data;
  const lock = async () =>
    (await database.document.send(new GetCommand({ TableName: table, Key: user('ACTIVE'), ConsistentRead: true }))).Item
      ?.data;
  const debrief = deriveDebrief(manifest, session, [], [], null);
  const store = new DynamoFinaliseStore(database.document, table);
  return { table, id, session, debrief, lifecycle, store, get, put, user, progress, lock };
}
test('concurrent finalisation commits result, progress, availability and lock release exactly once', async () => {
  const f = await fixture();
  const results = await Promise.all([f.store.commit(f.session, f.debrief), f.store.commit(f.session, f.debrief)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(await f.progress(), { completedAttempts: 1 });
  assert.equal(await f.lock(), undefined);
  assert.equal((await f.get('STATE'))?.data.view.debriefAvailable, true);
  assert.equal((await f.get('LIFECYCLE'))?.WorkPK, 'LIFECYCLE');
  assert.ok(await f.get('LIFECYCLE_HINT#playback'));
  assert.equal(await f.get('PLAYBACK_EXPORT'), undefined);
  assert.ok(await f.get('FINALISED'));
  assert.deepEqual(await f.store.commit(f.session, f.debrief), f.debrief);
});
test('platform error preserves first-attempt progress and does not delete a different active lock', async () => {
  const f = await fixture(true);
  const other = { sessionId: randomUUID(), requestId: randomUUID() };
  await database.document.send(new PutCommand({ TableName: f.table, Item: { ...f.user('ACTIVE'), data: other } }));
  await f.store.commit(f.session, f.debrief);
  assert.equal(await f.progress(), undefined);
  assert.deepEqual(await f.lock(), other);
});
test('cleanup and immutable cutoff are mandatory, and failure retains the active lock', async () => {
  for (const update of [{ schedulesDeleted: false }, { taskStoppedAt: null }]) {
    const f = await fixture();
    await f.put('LIFECYCLE', { ...f.lifecycle, ...update });
    await assert.rejects(f.store.commit(f.session, f.debrief));
    assert.equal(await f.progress(), undefined);
    assert.ok(await f.lock());
  }
  const f = await fixture();
  await f.put('STATE', { ...f.session, view: { ...f.session.view, endedAt: at } });
  await assert.rejects(f.store.commit(f.session, f.debrief));
  assert.equal(await f.get('DEBRIEF'), undefined);
  assert.ok(await f.lock());
});
test('progress and lock races cannot commit a stale result or release a replacement lock', async () => {
  for (const target of ['progress', 'lock'] as const) {
    const f = await fixture();
    const replacement = { sessionId: randomUUID(), requestId: randomUUID() };
    let raced = false;
    const client = {
      send: async (command: unknown, options: unknown) => {
        if (command instanceof TransactWriteCommand && !raced) {
          raced = true;
          const Key = f.user(target === 'progress' ? 'PROGRESS#wrong-upstream-port' : 'ACTIVE');
          await database.document.send(
            new PutCommand({
              TableName: f.table,
              Item: {
                ...Key,
                data: target === 'progress' ? { completedAttempts: 1 } : replacement,
              },
            }),
          );
        }
        return database.document.send(command as TransactWriteCommand, options as never);
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(new DynamoFinaliseStore(client, f.table).commit(f.session, f.debrief));
    assert.equal(await f.get('FINALISED'), undefined);
    assert.equal(await f.get('DEBRIEF'), undefined);
    assert.equal((await f.get('STATE'))?.data.view.debriefAvailable, false);
    if (target === 'lock') {
      assert.deepEqual(await f.lock(), replacement);
      assert.equal(await f.progress(), undefined);
    } else {
      assert.ok(await f.lock());
      assert.deepEqual(await f.progress(), { completedAttempts: 1 });
    }
  }
});

test('terminal and final Monitor snapshot races cannot publish a result or release the lock', async () => {
  for (const target of ['TERMINAL_RECORDING', 'MONITOR_FINAL']) {
    const f = await fixture();
    let raced = false;
    const client = {
      send: async (command: unknown, options: unknown) => {
        if (command instanceof TransactWriteCommand && !raced) {
          raced = true;
          await f.put(target, { schemaVersion: 1, cutoffAt: end });
        }
        return database.document.send(command as never, options as never);
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(new DynamoFinaliseStore(client, f.table).commit(f.session, f.debrief));
    assert.equal(await f.get('DEBRIEF'), undefined);
    assert.equal(await f.get('FINALISED'), undefined);
    assert.equal(await f.progress(), undefined);
    assert.ok(await f.lock());
  }
});
test('pending or corrupt playback does not gate result publication or replay evidence', async () => {
  for (const playback of [{ complete: false }, { invalid: true }]) {
    const f = await fixture();
    await f.put('PLAYBACK_EXPORT', playback);
    let reads = 0;
    const finalise = createFinaliseSession({
      store: f.store,
      manifest: async () => {
        reads++;
        return manifest;
      },
      evidence: async () => ({ commands: [], events: [], counters: null }),
    });
    await finalise(f.session);
    assert.equal((await f.get('STATE'))!.data.view.debriefAvailable, true);
    assert.equal(await f.lock(), undefined);
    assert.deepEqual(await f.progress(), { completedAttempts: 1 });
    await finalise(f.session);
    assert.equal(reads, 1);
  }
});

test('lost transaction response returns the saved debrief and never increments progress twice', async () => {
  const f = await fixture();
  let lost = false;
  const client = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as TransactWriteCommand, options as never);
      if (command instanceof TransactWriteCommand && !lost) {
        lost = true;
        throw new Error('response lost');
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  assert.deepEqual(await new DynamoFinaliseStore(client, f.table).commit(f.session, f.debrief), f.debrief);
  assert.equal(lost, true);
  assert.deepEqual(await f.progress(), { completedAttempts: 1 });
});
