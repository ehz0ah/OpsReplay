import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { encodeTerminalPage } from '../../../packages/contracts/private/terminal-persistence.js';
import { encodeSealedTerminalPage } from '../../../packages/contracts/private/terminal-sealing.js';
import {
  terminalFixtureStart as now,
  terminalOutput,
  terminalPage,
  terminalReady,
} from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import { DynamoMonitorRecordingStore } from '../src/monitor-recording-store.js';
import { DynamoTerminalRecordingStore, TerminalRecordingStoreError } from '../src/terminal-recording-store.js';
import { DynamoTerminalSealingStore } from '../src/terminal-sealing-store.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
async function fixture() {
  const table = `test-${randomUUID()}`;
  const sessionId = randomUUID();
  const key = (SK: string) => ({ PK: `SESSION#${sessionId}`, SK });
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
  const put = (SK: string, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key(SK), data } }));
  await put('STATE', { view: { status: 'provisioning', recording: { status: 'pending', reason: null } } });
  const leases = new DynamoMonitorRecordingStore(database.document, table);
  const lease = (await leases.claim({ sessionId, recorderId: 'gateway-1', now, leaseDurationMs: 15_000 })).lease;
  const recordings = new DynamoTerminalRecordingStore(database.document, table);
  const initial = await recordings.begin(lease, terminalReady(), now);
  const page = terminalPage([terminalPage().events[0]!, terminalOutput(), terminalOutput(3, at(2))]);
  const reference = encodeTerminalPage(sessionId, 1, 0, page).reference;
  const checkpoint = await recordings.commit(lease, initial, page, reference, at(3));
  const state = await leases.get(sessionId);
  assert.ok(state);
  await put('RECORDING', { ...state, status: 'draining', cutoffAt: at(1), drainDeadlineAt: at(10) });
  await put('STATE', { view: { status: 'resolved', recording: { status: 'draining', reason: null } } });
  const seals = new DynamoTerminalSealingStore(database.document, table);
  const sealed = encodeSealedTerminalPage(sessionId, 1, page.source, 0, page.events.slice(0, 2)).reference;
  const eventBytes = page.events.slice(0, 2).reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  const rows = async () =>
    ((await database.document.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? []).filter(
      (row) => String(row.SK).startsWith('TERMINAL_SEALED_CHUNK#'),
    );
  return {
    table,
    sessionId,
    key,
    put,
    lease,
    leases,
    recordings,
    checkpoint,
    page,
    reference,
    seals,
    sealed,
    eventBytes,
    rows,
  };
}

test('sealing publishes a durable prefix and only completes with cutoff exclusion', async () => {
  const f = await fixture();
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  assert.equal(initial.cursor, 0);
  assert.deepEqual(await f.seals.nextPage(f.sessionId, f.page.source, 0), f.reference);
  const next = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3));
  assert.equal(next.cursor, 2);
  assert.equal(next.complete, false);
  await assert.rejects(
    f.seals.finish(f.lease, next, null, at(3)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_stream',
  );
  const completed = await f.seals.finish(f.lease, next, { reference: f.reference, page: f.page }, at(3));
  assert.equal(completed.complete, true);
  assert.deepEqual(completed, await f.seals.get(f.sessionId));
  assert.equal((await f.rows()).length, 1);
  assert.equal((await f.leases.get(f.sessionId))?.status, 'draining');
});

test('concurrent duplicates and lost responses do not create two sealed page references', async () => {
  const f = await fixture();
  const starts = await Promise.all([
    f.seals.begin(f.lease, f.checkpoint, at(1), at(3)),
    f.seals.begin(f.lease, f.checkpoint, at(1), at(3)),
  ]);
  assert.deepEqual(starts[0], starts[1]);
  const uncertain = new DynamoTerminalSealingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand) throw new Error('Response lost');
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );
  const results = await Promise.all(
    starts.map((initial) => uncertain.append(f.lease, initial, f.sealed, f.eventBytes, at(3))),
  );
  assert.deepEqual(results[0], results[1]);
  const complete = await uncertain.finish(f.lease, results[0]!, { reference: f.reference, page: f.page }, at(3));
  assert.ok(complete.complete);
  assert.equal((await f.rows()).length, 1);
});

test('conflicting sealed bytes cannot be acknowledged as an exact duplicate', async () => {
  const f = await fixture();
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  const output = terminalOutput();
  assert.equal(output.type, 'output');
  assert.ok(output.type === 'output');
  const changed = encodeSealedTerminalPage(f.sessionId, 1, f.page.source, 0, [
    f.page.events[0]!,
    { ...output, data: Buffer.from('different bytes').toString('base64') },
  ]).reference;
  const results = await Promise.allSettled([
    f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3)),
    f.seals.append(f.lease, initial, changed, f.eventBytes, at(3)),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.ok(failed?.status === 'rejected');
  assert.ok(failed.reason instanceof TerminalRecordingStoreError && failed.reason.code === 'conflict');
  assert.equal((await f.rows()).length, 1);
});

test('cutoff exclusion must match the next event in an immutable committed page', async () => {
  const f = await fixture();
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  const partial = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3));
  const forgedPage = { ...f.page, events: [f.page.events[0]!, f.page.events[1]!, terminalOutput(3, at(1.5))] };
  await assert.rejects(
    f.seals.finish(f.lease, partial, { reference: f.reference, page: forgedPage }, at(3)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_stream',
  );
  const forgedReference = encodeTerminalPage(f.sessionId, 1, 0, forgedPage).reference;
  await assert.rejects(
    f.seals.finish(f.lease, partial, { reference: forgedReference, page: forgedPage }, at(3)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'conflict',
  );
  await assert.rejects(
    f.seals.finish(f.lease, initial, { reference: f.reference, page: f.page }, at(3)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_stream',
  );
  assert.deepEqual(await f.seals.get(f.sessionId), partial);
});

test('takeover resumes a partly copied final source page and fences the old generation', async () => {
  const f = await fixture();
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  const partial = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3));
  const replacement = await f.leases
    .claim({ sessionId: f.sessionId, recorderId: 'gateway-2', now: at(15), leaseDurationMs: 5_000 })
    .catch(() => undefined);
  assert.equal(replacement, undefined, 'Expired drain cannot be reclaimed');
  const state = await f.leases.get(f.sessionId);
  assert.ok(state);
  await f.put('RECORDING', { ...state, leaseExpiresAt: at(4) });
  const next = (
    await f.leases.claim({ sessionId: f.sessionId, recorderId: 'gateway-2', now: at(5), leaseDurationMs: 5_000 })
  ).lease;
  assert.deepEqual(await f.seals.begin(next, f.checkpoint, at(1), at(5)), partial);
  assert.deepEqual(await f.seals.nextPage(f.sessionId, f.page.source, 2), f.reference);
  await assert.rejects(
    f.seals.finish(f.lease, partial, { reference: f.reference, page: f.page }, at(5)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'stale_lease',
  );
  assert.ok((await f.seals.finish(next, partial, { reference: f.reference, page: f.page }, at(5))).complete);
  assert.equal((await f.rows()).length, 1);
});

test('does not begin from a forged checkpoint or finish at the drain deadline', async () => {
  const f = await fixture();
  await assert.rejects(
    f.seals.begin(f.lease, { ...f.checkpoint, recordedBytes: f.checkpoint.recordedBytes + 1 }, at(1), at(3)),
  );
  assert.equal(await f.seals.get(f.sessionId), undefined);
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  await assert.rejects(
    f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(10)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'stale_lease',
  );
  assert.equal((await f.rows()).length, 0);
  const stored = await database.document.send(
    new GetCommand({ TableName: f.table, Key: f.key('TERMINAL_SEAL'), ConsistentRead: true }),
  );
  assert.deepEqual(stored.Item?.data, initial);
});
