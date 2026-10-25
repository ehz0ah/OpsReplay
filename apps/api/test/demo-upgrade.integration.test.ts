import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { startLocalDatabase } from './local-dynamodb.js';
import {
  DemoUpgradeConflict,
  DemoUpgradeUnavailable,
  DemoUpgradeStore,
  demoReceiptKey,
} from '../src/demo-upgrade/store.js';
import { keys } from '../src/start-session/store.js';
import { effectivePlan } from '../src/shared/plan.js';

const owner = 'demo-learner';
const now = Date.parse('2026-10-26T00:00:00.000Z');
const expiresAt = '2026-10-26T02:00:00.000Z';
const signal = () => AbortSignal.timeout(10000);
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => {
  database = await startLocalDatabase();
});
after(() => database?.close());
async function fixture() {
  const table = `demo-${randomUUID()}`;
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
  const put = (key: object, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key, data } }));
  const read = async (key: object) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item?.data;
  return { table, put, read, store: new DemoUpgradeStore(database.document, table) };
}

test('concurrent duplicate activation commits one grant and one durable receipt', async () => {
  const f = await fixture();
  const id = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 4 }, () => f.store.activate(owner, id, expiresAt, () => now, signal())),
  );
  assert.deepEqual(results, Array(4).fill({ changed: true, expiresAt }));
  assert.deepEqual(await f.read(keys.plan(owner)), { plan: 'pro', expiresAt });
  const items = await database.document.send(
    new QueryCommand({
      TableName: f.table,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USER#${owner}` },
    }),
  );
  assert.equal(items.Count, 2);
  assert.equal(effectivePlan(await f.read(keys.plan(owner)), Date.parse(expiresAt)).plan, 'free');
});

test('new request IDs never extend a demo grant, overwrite another learner, or change attempts', async () => {
  const f = await fixture();
  const active = { sessionId: randomUUID(), requestId: randomUUID() };
  await f.put(keys.active(owner), active);
  await f.put(keys.plan('another'), { plan: 'free', expiresAt: null });
  const first = await f.store.activate(owner, randomUUID(), expiresAt, () => now, signal());
  const second = await f.store.activate(owner, randomUUID(), expiresAt, () => now + 1000, signal());
  assert.equal(first.changed, true);
  assert.deepEqual(second, { changed: false, expiresAt });
  assert.deepEqual(await f.read(keys.active(owner)), active);
  assert.deepEqual(await f.read(keys.plan('another')), { plan: 'free', expiresAt: null });
});

test('competing request IDs commit one activation while all receipts remain recoverable', async () => {
  const f = await fixture();
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const results = await Promise.all(ids.map((id) => f.store.activate(owner, id, expiresAt, () => now, signal())));
  assert.equal(results.filter((result) => result.changed).length, 1);
  for (const [index, id] of ids.entries())
    assert.deepEqual(await f.store.activate(owner, id, expiresAt, () => now, signal()), results[index]);
  assert.deepEqual(await f.read(keys.plan(owner)), { plan: 'pro', expiresAt });
});

test('existing paid/manual Pro grants retain their original expiry and provenance', async () => {
  const f = await fixture();
  for (const existingExpiry of [null, '2026-11-26T00:00:00.000Z', '2026-10-26T00:01:00.000Z']) {
    const original = { plan: 'pro', expiresAt: existingExpiry };
    await f.put(keys.plan(owner), original);
    assert.deepEqual(await f.store.activate(owner, randomUUID(), expiresAt, () => now, signal()), {
      changed: false,
      expiresAt: existingExpiry,
    });
    assert.deepEqual(await f.read(keys.plan(owner)), original);
  }
});

test('lost transaction response recovers the committed receipt without a second write', async () => {
  const f = await fixture();
  let writes = 0;
  const client = {
    send: async (command: GetCommand | TransactWriteCommand, options: object) => {
      if (command instanceof GetCommand) return database.document.send(command, options);
      writes++;
      await database.document.send(command, options);
      throw new Error('response lost after commit');
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DemoUpgradeStore(client, f.table);
  const id = randomUUID();
  await assert.rejects(
    store.activate(owner, id, expiresAt, () => now, signal()),
    /response lost/,
  );
  assert.deepEqual(await store.activate(owner, id, expiresAt, () => now, signal()), { changed: true, expiresAt });
  assert.equal(writes, 1);
});

test('failed transaction writes no receipt or plan and the same request remains retryable', async () => {
  const f = await fixture();
  const id = randomUUID();
  const client = {
    send: async (command: GetCommand | TransactWriteCommand, options: object) => {
      if (command instanceof TransactWriteCommand) throw new Error('storage unavailable');
      return database.document.send(command, options);
    },
  } as unknown as DynamoDBDocumentClient;
  await assert.rejects(
    new DemoUpgradeStore(client, f.table).activate(owner, id, expiresAt, () => now, signal()),
    /storage unavailable/,
  );
  assert.equal(await f.read(keys.plan(owner)), undefined);
  assert.equal(await f.read(demoReceiptKey(owner, id)), undefined);
  assert.equal((await f.store.activate(owner, id, expiresAt, () => now, signal())).changed, true);
});

test('corrupt plans and receipts fail closed and a receipt cannot be reused for another window', async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.store.activate(owner, id, expiresAt, () => now, signal());
  await assert.rejects(
    f.store.activate(owner, id, '2026-10-26T03:00:00.000Z', () => now, signal()),
    DemoUpgradeConflict,
  );
  const receipt = await f.read(demoReceiptKey(owner, id));
  await f.put(demoReceiptKey(owner, id), { ...receipt, ownerId: 'another' });
  await assert.rejects(
    f.store.activate(owner, id, expiresAt, () => now, signal()),
    /Invalid demo receipt/,
  );
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: 'private bad value' });
  await assert.rejects(
    f.store.activate(owner, randomUUID(), expiresAt, () => now, signal()),
    /Invalid account plan/,
  );
});

test('expiry reached during reads and cancellation cannot produce a new grant', async () => {
  const f = await fixture();
  const id = randomUUID();
  await assert.rejects(
    f.store.activate(owner, id, expiresAt, () => Date.parse(expiresAt), signal()),
    DemoUpgradeUnavailable,
  );
  await assert.rejects(f.store.activate(owner, id, expiresAt, () => now, AbortSignal.abort()));
  assert.equal(await f.read(keys.plan(owner)), undefined);
  assert.equal(await f.read(demoReceiptKey(owner, id)), undefined);
});
