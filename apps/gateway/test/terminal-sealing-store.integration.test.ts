import { expandCommandRow } from '../../../packages/session/src/command-reader.js';
import { initialCommandParser } from '../../../packages/contracts/private/command-evidence.js';
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
import { isCommandParserCheckpoint } from '../../../packages/contracts/private/command-evidence.js';

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

async function coverageFixture() {
  const f = await fixture();
  const state = (await f.leases.get(f.sessionId))!;
  await f.put('RECORDING', { ...state, startedAt: now });
  const value = {
    startedAt: now,
    cutoffAt: at(1),
    source: null,
    cursor: 0,
    frames: [],
    final: {
      type: 'metrics' as const,
      sample: { at: at(1), values: { request_rate: 1 } },
      counters: { totalRequests: 1, failedRequests: 1 },
      recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
    },
  };
  const sha256 = 'a'.repeat(64);
  const monitor = {
    phase: 'sealed' as const,
    source: null,
    after: 0,
    nextSequence: 0,
    frameCount: 0,
    sha256,
    objectKey: `sessions/${f.sessionId}/metrics/000000001/sealed/empty/000000-000000-${sha256}.json`,
  };
  const parser = { ...initialCommandParser(f.checkpoint.metadata.source), cursor: f.checkpoint.cursor };
  const captures = {
    schemaVersion: 1,
    baseline: { baselineAt: at(0), incomplete: false },
    cursor: 0,
    sequence: 0,
    retainedBytes: 0,
    incomplete: false,
  };
  await f.put('COMMAND_PARSER', parser);
  await f.put('CAPTURE_STATE', captures);
  await f.put('CAPTURE_COVERAGE', {
    schemaVersion: 1,
    cutoffAt: at(1),
    terminal: f.checkpoint,
    parser: { ...parser, cursor: 2 },
    captures,
  });
  return { ...f, value, monitor };
}

test('coverage uses the saved cutoff proof when the terminal clock leads the Gateway clock', async () => {
  const f = await coverageFixture();
  // The source is 250 ms ahead of the caller. Its valid checkpoint is already
  // committed, and the post-cutoff frontier proves coverage independently.
  const checkpoint = {
    ...f.checkpoint,
    metadata: { ...f.checkpoint.metadata, observedAt: at(3.25) },
  };
  await f.put('TERMINAL_RECORDING', checkpoint);
  const coverage = await f.leases.cover(f.lease, f.value, f.monitor, checkpoint, at(1.75));
  assert.deepEqual(coverage.terminal, checkpoint);
  assert.equal(coverage.coveredAt, at(1.75));
  assert.deepEqual(await f.leases.coverage(f.sessionId), coverage);
});

test('coverage permits task-independent sealing after the short drain and fences a takeover', async () => {
  const f = await coverageFixture();
  const coverage = await f.leases.cover(f.lease, f.value, f.monitor, f.checkpoint, at(3));
  assert.equal(coverage.taskDrainDeadlineAt, at(10));
  assert.equal((await f.leases.get(f.sessionId))?.drainDeadlineAt, coverage.sealingDeadlineAt);
  const latePage = terminalPage([], {
    ...f.page,
    events: [],
    nextSequence: f.checkpoint.cursor,
    observedAt: at(4),
  });
  await assert.rejects(f.recordings.commit(f.lease, f.checkpoint, latePage, null, at(4)));
  assert.deepEqual(await f.recordings.get(f.sessionId), f.checkpoint);
  const replacement = (await f.leases.claim({ sessionId: f.sessionId, recorderId: 'gateway-2', now: at(20) })).lease;
  await assert.rejects(f.leases.finishCovered(f.lease, coverage, at(21)));
  const initial = await f.seals.begin(replacement, f.checkpoint, at(1), at(21));
  const partial = await f.seals.append(replacement, initial, f.sealed, f.eventBytes, at(21), f.page.events.slice(0, 2));
  await f.seals.finish(replacement, partial, { reference: f.reference, page: f.page }, at(21));
  await f.leases.finishCovered(replacement, coverage, at(21));
  const complete = await f.leases.get(f.sessionId);
  assert.equal(complete?.status, 'complete');
  assert.equal(complete?.generation, 2);
  assert.deepEqual(complete?.sealed, f.monitor);
  await f.leases.finishCovered(replacement, coverage, at(21));
});

test('coverage recovers only an exact receipt after a lost response', async () => {
  const f = await coverageFixture();
  const uncertain = new DynamoMonitorRecordingStore(
    {
      send: async (command: unknown, options: unknown) => {
        const result = await database.document.send(command as TransactWriteCommand, options as never);
        if (command instanceof TransactWriteCommand) throw new Error('Response lost');
        return result;
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );
  const coverage = await uncertain.cover(f.lease, f.value, f.monitor, f.checkpoint, at(3));
  assert.deepEqual(await uncertain.cover(f.lease, f.value, f.monitor, f.checkpoint, at(4)), coverage);
  await assert.rejects(
    uncertain.cover(
      f.lease,
      f.value,
      f.monitor,
      { ...f.checkpoint, recordedBytes: f.checkpoint.recordedBytes + 1 },
      at(4),
    ),
  );
  await assert.rejects(
    uncertain.cover(
      f.lease,
      { ...f.value, final: { ...f.value.final, counters: { totalRequests: 2, failedRequests: 1 } } },
      f.monitor,
      f.checkpoint,
      at(4),
    ),
  );
  assert.deepEqual(await f.leases.coverage(f.sessionId), coverage);
});

test('coverage does not extend an expired drain or accept a changed terminal snapshot', async () => {
  const f = await coverageFixture();
  await assert.rejects(
    f.leases.cover(
      f.lease,
      f.value,
      f.monitor,
      { ...f.checkpoint, recordedBytes: f.checkpoint.recordedBytes + 1 },
      at(3),
    ),
  );
  await assert.rejects(f.leases.cover(f.lease, f.value, f.monitor, f.checkpoint, at(10)));
  assert.equal(await f.leases.coverage(f.sessionId), undefined);
  assert.equal((await f.leases.get(f.sessionId))?.drainDeadlineAt, at(10));
});

test('covered completion requires the exact frozen terminal checkpoint', async () => {
  const f = await coverageFixture();
  const coverage = await f.leases.cover(f.lease, f.value, f.monitor, f.checkpoint, at(3));
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(4));
  const partial = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(4), f.page.events.slice(0, 2));
  await f.seals.finish(f.lease, partial, { reference: f.reference, page: f.page }, at(4));
  const altered = { ...f.checkpoint, recordedBytes: f.checkpoint.recordedBytes + 1 };
  await f.put('TERMINAL_RECORDING', altered);
  await assert.rejects(f.leases.finishCovered(f.lease, coverage, at(4)));
  assert.equal((await f.leases.get(f.sessionId))?.status, 'draining');
  await f.put('TERMINAL_RECORDING', f.checkpoint);
  await f.leases.finishCovered(f.lease, coverage, at(4));
  assert.equal((await f.leases.get(f.sessionId))?.status, 'complete');
});

test('covered completion rejects a changed capture state or cutoff parser', async () => {
  for (const SK of ['CAPTURE_STATE', 'SEALED_COMMAND_PARSER']) {
    const f = await coverageFixture();
    const coverage = await f.leases.cover(f.lease, f.value, f.monitor, f.checkpoint, at(3));
    const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(4));
    const partial = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(4), f.page.events.slice(0, 2));
    await f.seals.finish(f.lease, partial, { reference: f.reference, page: f.page }, at(4));
    const get = async () =>
      (await database.document.send(new GetCommand({ TableName: f.table, Key: f.key(SK), ConsistentRead: true }))).Item!
        .data;
    const previous = await get();
    await f.put(
      SK,
      SK === 'CAPTURE_STATE'
        ? { ...previous, baseline: { ...previous.baseline, baselineAt: at(2) } }
        : { ...previous, input: 'different' },
    );
    await assert.rejects(f.leases.finishCovered(f.lease, coverage, at(4)));
    assert.equal((await f.leases.get(f.sessionId))?.status, 'draining');
    await f.put(SK, previous);
    await f.leases.finishCovered(f.lease, coverage, at(4));
    assert.equal((await f.leases.get(f.sessionId))?.status, 'complete');
  }
});

test('sealing publishes a durable prefix and only completes with cutoff exclusion', async () => {
  const f = await fixture();
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  assert.equal(initial.cursor, 0);
  assert.deepEqual(await f.seals.nextPage(f.sessionId, f.page.source, 0), f.reference);
  const next = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3), f.page.events.slice(0, 2));
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
    starts.map((initial) =>
      uncertain.append(f.lease, initial, f.sealed, f.eventBytes, at(3), f.page.events.slice(0, 2)),
    ),
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
  const changedEvents = [f.page.events[0]!, { ...output, data: Buffer.from('different bytes').toString('base64') }];
  const changed = encodeSealedTerminalPage(f.sessionId, 1, f.page.source, 0, changedEvents).reference;
  const changedBytes = changedEvents.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  const results = await Promise.allSettled([
    f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3), f.page.events.slice(0, 2)),
    f.seals.append(f.lease, initial, changed, changedBytes, at(3), changedEvents),
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
  const partial = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3), f.page.events.slice(0, 2));
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
  const partial = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3), f.page.events.slice(0, 2));
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
    f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(10), f.page.events.slice(0, 2)),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'stale_lease',
  );
  assert.equal((await f.rows()).length, 0);
  const stored = await database.document.send(
    new GetCommand({ TableName: f.table, Key: f.key('TERMINAL_SEAL'), ConsistentRead: true }),
  );
  assert.deepEqual(stored.Item?.data, initial);
});

test('sealed parser and command receipts advance atomically and reject different duplicate bytes', async () => {
  const f = await fixture();
  const initial = await f.seals.begin(f.lease, f.checkpoint, at(1), at(3));
  const events = f.page.events.slice(0, 2);
  const next = await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3), events);
  const parser = (
    await database.document.send(
      new GetCommand({ TableName: f.table, Key: f.key('SEALED_COMMAND_PARSER'), ConsistentRead: true }),
    )
  ).Item?.data;
  assert.ok(isCommandParserCheckpoint(parser));
  assert.equal(parser.cursor, next.cursor);
  assert.deepEqual(await f.seals.append(f.lease, initial, f.sealed, f.eventBytes, at(3), events), next);
  const different = [events[0]!, terminalOutput(2, events[1]!.recordedAt, Buffer.from('different'))];
  const changed = encodeSealedTerminalPage(f.sessionId, 1, f.page.source, 0, different).reference;
  await assert.rejects(f.seals.append(f.lease, initial, changed, f.eventBytes, at(3), different));
  assert.equal((await f.rows()).length, 1);
});

test('sealed overflow batches remain unpublished after interruption and replay the exact prefix', async () => {
  const f = await fixture();
  const marker = `\x1b]133;C;${Buffer.from(':').toString('base64')}\x07\x1b]133;D;0\x07`;
  const page = terminalPage([
    terminalPage().events[0]!,
    terminalOutput(2, at(1), Buffer.from(marker.repeat(45))),
    terminalOutput(3, at(2)),
  ]);
  const reference = encodeTerminalPage(f.sessionId, 1, 0, page).reference;
  await f.put('TERMINAL_RECORDING', {
    ...f.checkpoint,
    recordedBytes: page.events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0),
  });
  await f.put(`TERMINAL_CHUNK#${page.source}#000003`, reference);
  const checkpoint = (await f.recordings.get(f.sessionId))!;
  const initial = await f.seals.begin(f.lease, checkpoint, at(1), at(3));
  const events = page.events.slice(0, 2);
  const sealed = encodeSealedTerminalPage(f.sessionId, 1, page.source, 0, events).reference;
  const bytes = events.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0);
  let writes = 0;
  const interrupted = new DynamoTerminalSealingStore(
    {
      send: async (command: unknown, options: unknown) => {
        if (command instanceof TransactWriteCommand && ++writes === 2) throw new Error('sealed staging interrupted');
        return database.document.send(command as TransactWriteCommand, options as never);
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );
  await assert.rejects(
    interrupted.append(f.lease, initial, sealed, bytes, at(3), events),
    /sealed staging interrupted/,
  );
  assert.equal((await f.seals.get(f.sessionId))?.cursor, 0);
  const get = async (SK: string) =>
    (await database.document.send(new GetCommand({ TableName: f.table, Key: f.key(SK), ConsistentRead: true }))).Item
      ?.data;
  assert.equal(await get('SEALED_COMMAND#000001'), undefined);
  const next = await f.seals.append(f.lease, initial, sealed, bytes, at(3), events);
  assert.equal(next.cursor, 2);
  assert.equal((await get('SEALED_COMMAND_PARSER')).lossAt, null);
  const publication = await get('SEALED_COMMAND#000001');
  const commands = await expandCommandRow(database.document, f.table, f.sessionId, 'SEALED_COMMAND', {
    SK: 'SEALED_COMMAND#000001',
    data: publication,
  });
  assert.equal(commands.length, 45);
  assert.deepEqual(await f.seals.append(f.lease, initial, sealed, bytes, at(3), events), next);
});
