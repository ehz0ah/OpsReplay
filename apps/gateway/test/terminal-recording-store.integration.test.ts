import { expandCommandRow } from '../../../packages/session/src/command-reader.js';
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
import {
  encodeTerminalPage,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  terminalFixtureStart as now,
  terminalOutput,
  terminalPage,
  terminalReady,
} from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import {
  DynamoMonitorRecordingStore,
  type MonitorRecorderLease,
  type MonitorRecordingState,
} from '../src/monitor-recording-store.js';
import { DynamoTerminalRecordingStore, TerminalRecordingStoreError } from '../src/terminal-recording-store.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());
const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
const storeError = (code: TerminalRecordingStoreError['code']) => (error: unknown) =>
  error instanceof TerminalRecordingStoreError && error.code === code;

async function fixture() {
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
  const key = (SK: string) => ({ PK: `SESSION#${sessionId}`, SK });
  const put = (SK: string, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key(SK), data } }));
  const get = async (SK: string) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: key(SK), ConsistentRead: true }))).Item?.data;
  const chunks = async () =>
    ((await database.document.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? []).filter(
      (row) => String(row.SK).startsWith('TERMINAL_CHUNK#'),
    );
  await put('STATE', { view: { status: 'provisioning', recording: { status: 'pending', reason: null } } });
  const leases = new DynamoMonitorRecordingStore(database.document, table);
  const lease = (await leases.claim({ sessionId, recorderId: 'gateway-1', now, leaseDurationMs: 5_000 })).lease;
  const store = new DynamoTerminalRecordingStore(database.document, table);
  const page = terminalPage();
  const reference = encodeTerminalPage(sessionId, 1, 0, page).reference;
  return { table, sessionId, key, put, get, chunks, leases, lease, store, page, reference };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function wrappedStore(f: Fixture, send: (command: unknown, options: unknown) => Promise<unknown>) {
  return new DynamoTerminalRecordingStore({ send } as unknown as DynamoDBDocumentClient, f.table);
}
const send = (command: unknown, options: unknown) =>
  database.document.send(command as TransactWriteCommand, options as never);
async function draining(f: Fixture, deadline = at(4)) {
  const state = await f.leases.get(f.sessionId);
  assert.ok(state);
  await f.put('RECORDING', {
    ...state,
    status: 'draining',
    cutoffAt: at(2),
    drainDeadlineAt: deadline,
  } satisfies MonitorRecordingState);
}

test('commits byte-preserving references and checkpoint atomically without changing monitor or public state', async () => {
  const f = await fixture();
  const leaseState = await f.leases.get(f.sessionId);
  const publicState = await f.get('STATE');
  assert.equal(await f.store.get(f.sessionId), undefined);
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const next = await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  assert.equal(next.cursor, 1);
  assert.deepEqual(await f.store.get(f.sessionId), next);
  const rows = await f.chunks();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.data, f.reference);
  assert.deepEqual(await f.leases.get(f.sessionId), leaseState);
  assert.deepEqual(await f.get('STATE'), publicState);
  await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  assert.equal((await f.chunks()).length, 1);
  next.metadata.startedAt = at(99);
  assert.equal((await f.store.get(f.sessionId))?.metadata.startedAt, now);
});

test('racing identical begin and commit requests are duplicate-safe', async () => {
  const f = await fixture();
  const initial = await Promise.all([
    f.store.begin(f.lease, terminalReady(), now),
    f.store.begin(f.lease, terminalReady(), now),
  ]);
  assert.deepEqual(initial[0], initial[1]);
  const results = await Promise.all(
    initial.map((checkpoint) => f.store.commit(f.lease, checkpoint, f.page, f.reference, at(1))),
  );
  assert.deepEqual(results[0], results[1]);
  assert.equal((await f.chunks()).length, 1);
});

test('racing different bytes publish only one range and reject the other request', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const checkpoint = await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  const pages = [terminalPage([terminalOutput()]), terminalPage([terminalOutput(2, at(1), Buffer.from('different'))])];
  const results = await Promise.allSettled(
    pages.map((page) =>
      f.store.commit(f.lease, checkpoint, page, encodeTerminalPage(f.sessionId, 1, 1, page).reference, at(2)),
    ),
  );
  assert.equal(results.filter((value) => value.status === 'fulfilled').length, 1);
  const failure = results.find((value) => value.status === 'rejected') as PromiseRejectedResult;
  assert.ok(storeError('conflict')(failure.reason));
  assert.equal((await f.store.get(f.sessionId))?.cursor, 2);
  assert.equal((await f.chunks()).length, 2);
});

test('recovers lost begin and page responses from committed data', async () => {
  const f = await fixture();
  let responsesLost = 0;
  const uncertain = wrappedStore(f, async (command, options) => {
    const result = await send(command, options);
    if (command instanceof TransactWriteCommand) {
      responsesLost++;
      throw new Error('Response lost');
    }
    return result;
  });
  const initial = await uncertain.begin(f.lease, terminalReady(), now);
  const next = await uncertain.commit(f.lease, initial, f.page, f.reference, at(1));
  assert.equal(responsesLost, 2);
  assert.deepEqual(next, await f.store.get(f.sessionId));
  assert.equal((await f.chunks()).length, 1);
});

test('accepts an exact committed receipt after takeover during lost response recovery', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  let changed = false;
  const uncertain = wrappedStore(f, async (command, options) => {
    const result = await send(command, options);
    if (command instanceof TransactWriteCommand && !changed) {
      changed = true;
      await f.leases.claim({ sessionId: f.sessionId, recorderId: 'replacement', now: at(5), leaseDurationMs: 5_000 });
      throw new Error('Response lost after takeover');
    }
    return result;
  });
  const next = await uncertain.commit(f.lease, initial, f.page, f.reference, at(1));
  assert.equal(next.cursor, 1);
  assert.equal((await f.leases.get(f.sessionId))?.generation, 2);
});

test('does not mistake an uncommitted transport failure for a durable acknowledgement', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const failure = new Error('Transport failed before write');
  const failed = wrappedStore(f, async (command, options) => {
    if (command instanceof TransactWriteCommand) throw failure;
    return send(command, options);
  });
  await assert.rejects(failed.commit(f.lease, initial, f.page, f.reference, at(1)), (actual) => actual === failure);
  assert.deepEqual(await f.store.get(f.sessionId), initial);
  assert.equal((await f.chunks()).length, 0);
});

test('pure transaction conflicts retry begin and commit in place with the same token', async () => {
  const f = await fixture();
  const attempts = new Map<string, number>();
  const retrying = wrappedStore(f, async (command, options) => {
    if (command instanceof TransactWriteCommand) {
      const token = command.input.ClientRequestToken!;
      const count = (attempts.get(token) ?? 0) + 1;
      attempts.set(token, count);
      if (count === 1)
        throw Object.assign(new Error('Contention'), {
          name: 'TransactionCanceledException',
          CancellationReasons: command.input.TransactItems!.map((_, index) => ({
            Code: index === 0 ? 'TransactionConflict' : 'None',
          })),
        });
    }
    return send(command, options);
  });
  const initial = await retrying.begin(f.lease, terminalReady(), now);
  await retrying.commit(f.lease, initial, f.page, f.reference, at(1));
  assert.deepEqual([...attempts.values()], [2, 2]);
  assert.equal((await f.leases.get(f.sessionId))?.generation, 1);
  assert.equal((await f.chunks()).length, 1);
});

test('empty reads commit only metadata and cannot acknowledge missing events', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const previous = await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  const empty = terminalPage([], { nextSequence: 1, latestSequence: 1, observedAt: at(2) });
  const next = await f.store.commit(f.lease, previous, empty, null, at(2));
  assert.equal(next.cursor, 1);
  assert.equal(next.metadata.observedAt, at(2));
  assert.equal(next.recordedBytes, previous.recordedBytes);
  assert.equal((await f.chunks()).length, 1);
  await f.store.commit(f.lease, previous, empty, null, at(2));
  await assert.rejects(f.store.commit(f.lease, initial, empty, null, at(2)), storeError('invalid_stream'));
});

test('a new recorder resumes terminal state while old generations and source changes are fenced', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const previous = await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  const replacement = (
    await f.leases.claim({ sessionId: f.sessionId, recorderId: 'gateway-2', now: at(5), leaseDurationMs: 5_000 })
  ).lease;
  assert.deepEqual(await f.store.begin(replacement, terminalReady({ observedAt: at(5) }), at(5)), previous);
  await assert.rejects(f.store.begin(f.lease, terminalReady(), at(5)), storeError('stale_lease'));
  await assert.rejects(
    f.store.begin(replacement, terminalReady({ source: randomUUID(), observedAt: at(5) }), at(5)),
    storeError('invalid_stream'),
  );
  const page = terminalPage([terminalOutput()]);
  await assert.rejects(
    f.store.commit(f.lease, previous, page, encodeTerminalPage(f.sessionId, 1, 1, page).reference, at(5)),
    storeError('stale_lease'),
  );
  await f.store.commit(replacement, previous, page, encodeTerminalPage(f.sessionId, 2, 1, page).reference, at(5));
  assert.equal((await f.store.get(f.sessionId))?.cursor, 2);
  assert.equal((await f.chunks()).length, 2);
});

test('checks drain deadline and lease generation in the same transaction as reference publication', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  let changed = false;
  const racing = wrappedStore(f, async (command, options) => {
    if (command instanceof TransactWriteCommand && !changed) {
      changed = true;
      await f.leases.claim({ sessionId: f.sessionId, recorderId: 'gateway-2', now: at(5), leaseDurationMs: 5_000 });
    }
    return send(command, options);
  });
  await assert.rejects(racing.commit(f.lease, initial, f.page, f.reference, at(1)), storeError('stale_lease'));
  assert.equal((await f.chunks()).length, 0);
  const active = await f.leases.get(f.sessionId);
  assert.ok(active?.recorderId);
  const lease: MonitorRecorderLease = {
    sessionId: f.sessionId,
    recorderId: active.recorderId,
    generation: active.generation,
  };
  await draining(f, at(7));
  await f.store.commit(lease, initial, f.page, encodeTerminalPage(f.sessionId, 2, 0, f.page).reference, at(6));
  const previous = await f.store.get(f.sessionId);
  assert.ok(previous);
  await assert.rejects(
    f.store.commit(lease, previous, terminalPage([], { observedAt: at(7) }), null, at(7)),
    storeError('stale_lease'),
  );
  assert.equal((await f.chunks()).length, 1);
});

test('rejects forged references, missing prefixes, invalid checkpoints, and stale CAS without writes', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  for (const reference of [
    { ...f.reference, sha256: 'a'.repeat(64) },
    { ...f.reference, byteLength: f.reference.byteLength + 1 },
    { ...f.reference, objectKey: 'private/other.json' },
    null,
  ]) {
    await assert.rejects(f.store.commit(f.lease, initial, f.page, reference, at(1)), storeError('invalid_input'));
  }
  const gap = terminalPage([terminalOutput(3)]);
  await assert.rejects(f.store.commit(f.lease, initial, gap, null, at(1)), storeError('invalid_stream'));
  await assert.rejects(
    f.store.commit(f.lease, { ...initial, recordedBytes: -1 }, f.page, f.reference, at(1)),
    storeError('invalid_input'),
  );
  const changed: TerminalRecordingCheckpoint = { ...initial, metadata: { ...initial.metadata, observedAt: at(1) } };
  await assert.rejects(f.store.commit(f.lease, changed, f.page, f.reference, at(1)), storeError('invalid_stream'));
  await f.put('TERMINAL_RECORDING', changed);
  await assert.rejects(f.store.commit(f.lease, initial, f.page, f.reference, at(1)), storeError('conflict'));
  assert.equal((await f.chunks()).length, 0);
});

test('command checkpoint and events commit with terminal pages and replay once across takeover', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  let checkpoint = await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  const marker = `\x1b]133;C;${Buffer.from('cat config').toString('base64')}\x07`;
  const first = terminalPage([terminalOutput(2, at(1), Buffer.from(marker + 'proxy_'))]);
  checkpoint = await f.store.commit(
    f.lease,
    checkpoint,
    first,
    encodeTerminalPage(f.sessionId, 1, 1, first).reference,
    at(2),
  );
  assert.equal((await f.get('COMMAND_PARSER')).active.event.outputExcerpt, 'proxy_');
  assert.equal(await f.get('COMMAND#000001'), undefined);
  const replacement = (
    await f.leases.claim({ sessionId: f.sessionId, recorderId: 'gateway-2', now: at(5), leaseDurationMs: 5_000 })
  ).lease;
  const last = terminalPage([terminalOutput(3, at(5), Buffer.from('pass\x1b]133;D;1\x07'))], { observedAt: at(5) });
  const reference = encodeTerminalPage(f.sessionId, 2, 2, last).reference;
  const next = await f.store.commit(replacement, checkpoint, last, reference, at(6));
  assert.equal((await f.get('COMMAND#000001')).command, 'cat config');
  assert.equal((await f.get('COMMAND#000001')).outputExcerpt, 'proxy_pass');
  assert.equal((await f.get('COMMAND#000001')).exitStatus, 1);
  assert.equal((await f.get('COMMAND_PARSER')).cursor, 3);
  assert.deepEqual(await f.store.commit(replacement, checkpoint, last, reference, at(6)), next);
});

test('rejected terminal commits cannot advance command evidence', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const checkpoint = await f.store.commit(f.lease, initial, f.page, f.reference, at(1));
  const marker = `\x1b]133;C;${Buffer.from('true').toString('base64')}\x07\x1b]133;D;0\x07`;
  const page = terminalPage([terminalOutput(2, at(1), Buffer.from(marker))]);
  const failed = wrappedStore(f, async (command, options) => {
    if (command instanceof TransactWriteCommand) throw new Error('before commit');
    return send(command, options);
  });
  await assert.rejects(
    failed.commit(f.lease, checkpoint, page, encodeTerminalPage(f.sessionId, 1, 1, page).reference, at(2)),
  );
  assert.equal((await f.get('COMMAND_PARSER')).cursor, 1);
  assert.equal(await f.get('COMMAND#000001'), undefined);
});

test('rejects corrupt saved state and snapshots lease and metadata before async I/O', async () => {
  const f = await fixture();
  let mutate = true;
  const lease = { ...f.lease };
  const ready = terminalReady();
  const snapshot = wrappedStore(f, async (command, options) => {
    if (mutate) {
      mutate = false;
      lease.generation = 99;
      ready.source = randomUUID();
    }
    return send(command, options);
  });
  const initial = await snapshot.begin(lease, ready, now);
  assert.equal(initial.metadata.source, terminalReady().source);
  await f.put('TERMINAL_RECORDING', { ...initial, cursor: 1 });
  await assert.rejects(f.store.get(f.sessionId), storeError('invalid_store'));
  await assert.rejects(f.store.get('invalid'), storeError('invalid_input'));
});

const markerCommand = (command: string) => `\x1b]133;C;${Buffer.from(command).toString('base64')}\x07\x1b]133;D;0\x07`;
const manyPage = (command = ':') =>
  terminalPage([terminalPage().events[0]!, terminalOutput(2, now, Buffer.from(markerCommand(command).repeat(45)))]);

test('45 commands in one source page publish bounded batches without parser loss', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const page = manyPage();
  await f.store.commit(f.lease, initial, page, encodeTerminalPage(f.sessionId, 1, 0, page).reference, at(1));
  const parser = await f.get('COMMAND_PARSER');
  assert.equal(parser.count, 45);
  assert.equal(parser.lossAt, null);
  const publication = await f.get('COMMAND#000001');
  assert.deepEqual(
    publication.batches.map((batch: { first: number; last: number }) => batch.last - batch.first + 1),
    [20, 20, 5],
  );
  const commands = await expandCommandRow(database.document, f.table, f.sessionId, 'COMMAND', {
    SK: 'COMMAND#000001',
    data: publication,
  });
  assert.equal(commands.length, 45);
  assert.deepEqual(
    commands.map((command) => command.seq),
    Array.from({ length: 45 }, (_, index) => index + 1),
  );
});

test('interrupted large-page staging stays invisible and cannot reserve a competing command range', async () => {
  const f = await fixture();
  const initial = await f.store.begin(f.lease, terminalReady(), now);
  const page = manyPage('first');
  let stages = 0;
  const interrupted = wrappedStore(f, async (command, options) => {
    if (command instanceof TransactWriteCommand && ++stages === 2) throw new Error('staging interrupted');
    return send(command, options);
  });
  await assert.rejects(
    interrupted.commit(f.lease, initial, page, encodeTerminalPage(f.sessionId, 1, 0, page).reference, at(1)),
    /staging interrupted/,
  );
  assert.equal((await f.store.get(f.sessionId))?.cursor, 0);
  assert.equal(await f.get('COMMAND#000001'), undefined);
  assert.equal(await f.get('COMMAND_PARSER'), undefined);
  const competing = manyPage('second');
  await f.store.commit(f.lease, initial, competing, encodeTerminalPage(f.sessionId, 1, 0, competing).reference, at(1));
  const commands = await expandCommandRow(database.document, f.table, f.sessionId, 'COMMAND', {
    SK: 'COMMAND#000001',
    data: await f.get('COMMAND#000001'),
  });
  assert.equal(commands.length, 45);
  assert.ok(commands.every((command) => command.command === 'second'));
  await assert.rejects(
    f.store.commit(f.lease, initial, page, encodeTerminalPage(f.sessionId, 1, 0, page).reference, at(1)),
    storeError('conflict'),
  );
});

test('cutoff projection reads only the boundary S3 page from saved parser checkpoints', async () => {
  const f = await fixture();
  let checkpoint = await f.store.begin(f.lease, terminalReady(), now);
  const pages = new Map<string, ReturnType<typeof terminalPage>>();
  checkpoint = await f.store.commit(f.lease, checkpoint, f.page, f.reference, now);
  const texts = [
    markerCommand('before'),
    `\x1b]133;C;${Buffer.from('open').toString('base64')}\x07partial`,
    markerCommand('after'),
  ];
  for (let index = 0; index < texts.length; index++) {
    const page = terminalPage([terminalOutput(index + 2, at(index), Buffer.from(texts[index]!))], {
      observedAt: at(index),
    });
    const reference = encodeTerminalPage(f.sessionId, 1, index + 1, page).reference;
    pages.set(reference.objectKey, page);
    checkpoint = await f.store.commit(f.lease, checkpoint, page, reference, at(index));
  }
  let reads = 0;
  const parser = await f.store.cutoffParser(
    f.sessionId,
    checkpoint,
    at(1),
    {
      readLive: async (_id, reference) => {
        reads++;
        return pages.get(reference.objectKey)!;
      },
    },
    new AbortController().signal,
  );
  assert.equal(reads, 1);
  assert.equal(parser.cursor, 3);
  assert.equal(parser.count, 2);
  assert.equal(parser.active?.event.command, 'open');
  assert.equal(parser.active?.event.outputExcerpt, 'partial');
  assert.equal(parser.lossAt, null);
});
