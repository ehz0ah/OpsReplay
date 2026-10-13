import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  lifecycleWorkItem,
  type SessionLifecycleState,
} from '../../../packages/contracts/private/session-lifecycle.js';
import { manifestHash, manifestKey } from '../../../packages/session/src/manifest.js';
import { DynamoHintStore, HintReleaseError } from '../src/release-hint/store.js';
import { sessionRecord } from './session-fixture.js';
import { startLocalDatabase } from './local-dynamodb.js';

const manifest = JSON.parse(
  readFileSync(new URL('../../../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
) as {
  id: string;
  version: string;
  hints: { id: string; text: string; minElapsedMinutes: number }[];
};
const base = Date.parse('2026-10-13T00:00:00.000Z');
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
let database: Awaited<ReturnType<typeof startLocalDatabase>>;

before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

async function fixture(client: DynamoDBDocumentClient = database.document) {
  const id = randomUUID();
  const table = `hint-${randomUUID()}`;
  const owner = 'learner-1';
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
  session.ownerId = owner;
  session.view.createdAt = at(-120);
  session.view.status = 'ready';
  session.view.readyAt = at(0);
  session.view.endsAt = at(1200);
  session.view.recovery = { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 };
  session.view.hints.nextAvailableAt = at(180);
  session.accessGrant.admittedAt = at(-120);
  session.provisioningDeadline = at(60);
  session.launchRecoveryDeadline = at(360);
  session.pins.manifestSha256 = manifestHash(manifest);
  session.hintPlan = manifest.hints.map(({ id: hintId, minElapsedMinutes }) => ({
    id: hintId,
    minElapsedMinutes,
  }));
  const source = randomUUID();
  const lifecycle: SessionLifecycleState = {
    schemaVersion: 1,
    sessionId: id,
    createdAt: session.view.createdAt,
    readyAt: session.view.readyAt,
    terminalSource: randomUUID(),
    lastSeenAt: at(0),
    lastMonitorAt: at(0),
    recovery: { ...session.view.recovery },
    drainDeadlineAt: null,
    taskStoppedAt: null,
    schedulesDeleted: false,
  };
  const observation = {
    schemaVersion: 1,
    sessionId: id,
    startedAt: at(0),
    source,
    cursor: 1,
    sequence: 1,
    at: at(0),
    recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
  };
  const sessionKey = (SK: string) => ({ PK: `SESSION#${id}`, SK });
  const put = (Key: { PK: string; SK: string }, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...Key, data } }));
  await Promise.all([
    put(sessionKey('STATE'), session),
    database.document.send(new PutCommand({ TableName: table, Item: lifecycleWorkItem(lifecycle) })),
    put(sessionKey('MONITOR_OBSERVATION'), observation),
    put(manifestKey(manifest.id, manifest.version, session.pins.manifestSha256), manifest),
  ]);
  const get = async (SK: string) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: sessionKey(SK), ConsistentRead: true }))).Item
      ?.data;
  const rows = async (prefix: string) =>
    (
      await database.document.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': `SESSION#${id}`, ':prefix': prefix },
          ConsistentRead: true,
        }),
      )
    ).Items ?? [];
  return {
    id,
    table,
    owner,
    session,
    lifecycle,
    observation,
    sessionKey,
    put,
    get,
    rows,
    store: new DynamoHintStore(client, table),
  };
}

const code = (expected: HintReleaseError['code']) => (error: unknown) =>
  error instanceof HintReleaseError && error.code === expected;

test('a same-request burst commits one authored hint, event, counter, and replayable receipt', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.store.release(f.id, f.owner, requestId, at(180), AbortSignal.timeout(10_000))),
  );
  assert.equal(results.filter((result) => !result.replayed).length, 1);
  for (const result of results) {
    assert.equal(result.hint.id, manifest.hints[0]!.id);
    assert.equal(result.hint.text, manifest.hints[0]!.text);
    assert.equal(result.hint.releasedAt, at(180));
    assert.equal(result.remaining, 1);
  }
  const saved = await f.get('STATE');
  assert.deepEqual(saved.view.hints, {
    released: [results[0]!.hint],
    remaining: 1,
    nextAvailableAt: at(360),
  });
  assert.equal(saved.view.assistance.hintsReleased, 1);
  assert.deepEqual(await f.get(`HINT#${manifest.hints[0]!.id}`), results[0]!.hint);
  assert.equal((await f.rows('EVENT#')).length, 1);
  assert.equal((await f.rows('REQUEST#')).length, 1);

  await database.document.send(new DeleteCommand({ TableName: f.table, Key: f.sessionKey('STATE') }));
  const replay = await f.store.release(f.id, f.owner, requestId, at(900), AbortSignal.timeout(10_000));
  assert.deepEqual(replay, { ...results[0], replayed: true });
});

test('hint availability, exhaustion, readiness, deadline, ownership, and operation collisions fail explicitly', async () => {
  const f = await fixture();
  await assert.rejects(f.store.release(f.id, f.owner, randomUUID(), at(120)), (error: unknown) => {
    assert.ok(error instanceof HintReleaseError);
    assert.equal(error.code, 'HINT_NOT_AVAILABLE');
    assert.equal(error.retryAfterSeconds, 60);
    return true;
  });
  await assert.rejects(f.store.release(f.id, 'other-user', randomUUID(), at(180)), code('NOT_FOUND'));
  await assert.rejects(f.store.release(f.id, f.owner, randomUUID(), at(1200)), code('SESSION_TERMINAL'));

  const provisioning = structuredClone(f.session);
  provisioning.view.status = 'provisioning';
  provisioning.view.readyAt = null;
  provisioning.view.endsAt = null;
  provisioning.view.recovery = null;
  provisioning.view.hints.nextAvailableAt = null;
  await f.put(f.sessionKey('STATE'), provisioning);
  await assert.rejects(f.store.release(f.id, f.owner, randomUUID(), at(180)), code('SESSION_NOT_READY'));

  await f.put(f.sessionKey('STATE'), f.session);
  await f.put(f.sessionKey('STATE'), {
    ...f.session,
    view: { ...f.session.view, status: 'ended', statusReason: 'learner_ended', endedAt: at(179) },
  });
  await assert.rejects(f.store.release(f.id, f.owner, randomUUID(), at(180)), code('SESSION_TERMINAL'));

  await f.put(f.sessionKey('STATE'), f.session);
  const collision = randomUUID();
  await f.put(f.sessionKey(`REQUEST#${collision}`), {
    schemaVersion: 1,
    operation: 'end_session',
    ownerId: f.owner,
    requestId: collision,
    sessionId: f.id,
  });
  await assert.rejects(f.store.release(f.id, f.owner, collision, at(180)), code('IDEMPOTENCY_CONFLICT'));

  await f.store.release(f.id, f.owner, randomUUID(), at(180));
  await f.store.release(f.id, f.owner, randomUUID(), at(360));
  await assert.rejects(f.store.release(f.id, f.owner, randomUUID(), at(361)), code('NO_HINTS_REMAINING'));
});

test('distinct due requests serialize through the authored prefix without losing either hint', async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.store.release(f.id, f.owner, randomUUID(), at(420), AbortSignal.timeout(10_000)),
    f.store.release(f.id, f.owner, randomUUID(), at(420), AbortSignal.timeout(10_000)),
  ]);
  assert.deepEqual(new Set(results.map((result) => result.hint.id)), new Set(manifest.hints.map((hint) => hint.id)));
  assert.equal((await f.rows('HINT#')).length, 2);
  assert.equal((await f.rows('EVENT#')).length, 2);
  const saved = await f.get('STATE');
  assert.deepEqual(
    saved.view.hints.released.map((hint: { id: string }) => hint.id),
    manifest.hints.map((hint) => hint.id),
  );
  assert.equal(saved.view.hints.remaining, 0);
  assert.equal(saved.view.assistance.hintsReleased, 2);
});

test('recovery frontiers and the immutable manifest are checked before any hint is committed', async () => {
  const recovered = await fixture();
  const recovery = { state: 'met' as const, sustainedSeconds: 60, requiredSeconds: 60 };
  await Promise.all([
    recovered.put(recovered.sessionKey('LIFECYCLE'), { ...recovered.lifecycle, recovery, lastMonitorAt: at(180) }),
    recovered.put(recovered.sessionKey('MONITOR_OBSERVATION'), {
      ...recovered.observation,
      sequence: 2,
      cursor: 2,
      at: at(180),
      recovery,
    }),
  ]);
  await assert.rejects(
    recovered.store.release(recovered.id, recovered.owner, randomUUID(), at(180)),
    code('SESSION_TERMINAL'),
  );
  assert.equal((await recovered.rows('HINT#')).length, 0);

  const mismatched = await fixture();
  const state = await mismatched.get('STATE');
  state.hintPlan[0].id = 'different-hint';
  state.view.hints.remaining = state.hintPlan.length;
  await mismatched.put(mismatched.sessionKey('STATE'), state);
  await assert.rejects(
    mismatched.store.release(mismatched.id, mismatched.owner, randomUUID(), at(180)),
    code('INTERNAL_ERROR'),
  );
  assert.equal((await mismatched.rows('HINT#')).length, 0);
});

test('a recovery observation racing the transaction prevents the hint and assistance writes', async () => {
  let beforeTransaction: (() => Promise<void>) | undefined;
  const client = {
    send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof TransactWriteCommand && beforeTransaction) {
        const update = beforeTransaction;
        beforeTransaction = undefined;
        await update();
      }
      return database.document.send(command as never, options);
    },
  } as unknown as DynamoDBDocumentClient;
  const f = await fixture(client);
  const recovery = { state: 'met' as const, sustainedSeconds: 60, requiredSeconds: 60 };
  beforeTransaction = async () => {
    await f.put(f.sessionKey('MONITOR_OBSERVATION'), {
      ...f.observation,
      sequence: 2,
      cursor: 2,
      at: at(180),
      recovery,
    });
  };
  await assert.rejects(
    f.store.release(f.id, f.owner, randomUUID(), at(180), AbortSignal.timeout(10_000)),
    code('SESSION_TERMINAL'),
  );
  assert.equal((await f.rows('HINT#')).length, 0);
  assert.equal((await f.rows('EVENT#')).length, 0);
  assert.equal((await f.rows('REQUEST#')).length, 0);
});

test('a benign observation race retries the full snapshot and commits one hint', async () => {
  let beforeTransaction: (() => Promise<void>) | undefined;
  let transactionAttempts = 0;
  const client = {
    send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof TransactWriteCommand) {
        transactionAttempts += 1;
        if (beforeTransaction) {
          const update = beforeTransaction;
          beforeTransaction = undefined;
          await update();
        }
      }
      return database.document.send(command as never, options);
    },
  } as unknown as DynamoDBDocumentClient;
  const f = await fixture(client);
  beforeTransaction = async () => {
    await f.put(f.sessionKey('MONITOR_OBSERVATION'), {
      ...f.observation,
      sequence: 2,
      cursor: 2,
      at: at(1),
    });
  };

  const result = await f.store.release(f.id, f.owner, randomUUID(), at(180), AbortSignal.timeout(10_000));

  assert.equal(result.replayed, false);
  assert.equal(transactionAttempts, 2);
  assert.equal((await f.rows('HINT#')).length, 1);
  assert.equal((await f.rows('EVENT#')).length, 1);
  assert.equal((await f.rows('REQUEST#')).length, 1);
  const saved = await f.get('STATE');
  assert.equal(saved.view.assistance.hintsReleased, 1);
});

test('an unknown transaction response reconciles the committed request receipt', async () => {
  let inject = true;
  const client = {
    send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      const result = await database.document.send(command as never, options);
      if (command instanceof TransactWriteCommand && inject) {
        inject = false;
        throw new Error('injected lost response');
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const f = await fixture(client);
  const result = await f.store.release(f.id, f.owner, randomUUID(), at(180), AbortSignal.timeout(10_000));
  assert.equal(result.replayed, true);
  assert.equal((await f.rows('HINT#')).length, 1);
  assert.equal((await f.rows('EVENT#')).length, 1);
});

test('cancellation after a committed transaction is replayable and cannot count twice', async () => {
  const controller = new AbortController();
  let cancel = true;
  const client = {
    send: async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      const result = await database.document.send(command as never, options);
      if (command instanceof TransactWriteCommand && cancel) {
        cancel = false;
        controller.abort();
        const error = new Error('injected cancellation');
        error.name = 'AbortError';
        throw error;
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const f = await fixture(client);
  const requestId = randomUUID();
  await assert.rejects(f.store.release(f.id, f.owner, requestId, at(180), controller.signal), {
    name: 'AbortError',
  });
  const replay = await new DynamoHintStore(database.document, f.table).release(f.id, f.owner, requestId, at(300));
  assert.equal(replay.replayed, true);
  assert.equal((await f.rows('HINT#')).length, 1);
  assert.equal((await f.rows('EVENT#')).length, 1);
  assert.equal((await f.rows('REQUEST#')).length, 1);
  const saved = await f.get('STATE');
  assert.equal(saved.view.assistance.hintsReleased, 1);
});
