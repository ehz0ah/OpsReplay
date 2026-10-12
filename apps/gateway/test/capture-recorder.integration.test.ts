import { stageCommandEvidence } from '../src/command-publication.js';
import { TerminalRecordingStoreError } from '../src/terminal-recording-store.js';
import { terminalReady } from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { initialTerminalCheckpoint } from '../../../packages/contracts/private/terminal-persistence.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { CaptureRecorder, type CaptureClient } from '../src/capture-recorder.js';
import {
  commandId,
  initialCommandParser,
  type CommandEvidence,
} from '../../../packages/contracts/private/command-evidence.js';
import type { FileCapture } from '../../../packages/contracts/private/file-capture.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60000 },
);
after(() => database?.close());
const at = '2026-10-12T00:00:00.000Z';
async function fixture() {
  const table = `test-${randomUUID()}`;
  const id = randomUUID();
  const source = randomUUID();
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
  const key = (SK: string) => ({ PK: `SESSION#${id}`, SK });
  const put = (SK: string, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key(SK), data } }));
  const get = async (SK: string) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: key(SK), ConsistentRead: true }))).Item?.data;
  const lease = { sessionId: id, recorderId: 'gateway', generation: 1 };
  const recording = {
    recorderId: 'gateway',
    generation: 1,
    status: 'recording',
    leaseExpiresAt: '2026-10-12T00:00:15.000Z',
  };
  await put('RECORDING', recording);
  for (let seq = 1; seq <= 2; seq++)
    await put(`COMMAND#${String(seq).padStart(6, '0')}`, {
      id: commandId(source, seq),
      at,
      kind: 'command',
      seq,
      endedAt: at,
      command: 'true',
      exitStatus: 0,
      source: 'learner',
      changedFiles: [],
      outputExcerpt: '',
      outputTruncated: false,
      metrics: null,
    } satisfies CommandEvidence);
  await put('COMMAND_PARSER', { ...initialCommandParser(source), count: 2 });
  const objects = new Map<string, Buffer>();
  let calls = 0;
  let failUpload = false;
  const s3 = {
    send: async (command: PutObjectCommand) => {
      if (failUpload) throw new Error('upload failed');
      objects.set(command.input.Key!, Buffer.from(command.input.Body as Buffer));
      return {};
    },
  } as unknown as S3Client;
  const client: CaptureClient = {
    baseline: async () => ({ baselineAt: at, incomplete: false, unavailable: false }),
    capture: async (request) => {
      calls++;
      return {
        schemaVersion: 1,
        ...request,
        sequence: request.commandSeq,
        baselineAt: at,
        startedAt: at,
        completedAt: at,
        files: [],
        logs: [],
        metrics: { at, values: { request_rate: 1 } },
        incomplete: false,
        unavailable: false,
      } satisfies FileCapture;
    },
  };
  const create = (dynamo = database.document, capture = client) =>
    new CaptureRecorder(dynamo, table, s3, 'test-recordings', capture, () => at);
  return {
    id,
    source,
    table,
    lease,
    recording,
    key,
    put,
    get,
    objects,
    client,
    create,
    calls: () => calls,
    failUpload: () => {
      failUpload = true;
    },
  };
}
test('baseline, receipt, upload and cursor commit are bounded and duplicate-safe', async () => {
  const f = await fixture();
  const recorder = f.create();
  await recorder.baseline(f.lease, new AbortController().signal);
  await recorder.collect(f.lease, new AbortController().signal);
  const state = await f.get('CAPTURE_STATE');
  assert.equal(state.cursor, 2);
  assert.equal(state.sequence, 2);
  assert.equal(state.incomplete, false);
  assert.equal(
    state.retainedBytes,
    [...f.objects.values()].reduce((n, b) => n + b.length, 0),
  );
  await recorder.collect(f.lease, new AbortController().signal);
  assert.equal(f.calls(), 2);
  const receipt = await f.get('CAPTURE#000001');
  assert.ok(f.objects.has(receipt.objectKey));
});
test('upload failure and stale lease cannot advance capture state', async () => {
  const f = await fixture();
  const recorder = f.create();
  const signal = new AbortController().signal;
  await recorder.baseline(f.lease, signal);
  f.failUpload();
  await assert.rejects(recorder.collect(f.lease, signal), /upload failed/);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 0);
  const g = await fixture();
  await g.create().baseline(g.lease, signal);
  await g.put('RECORDING', { ...g.recording, generation: 2 });
  await assert.rejects(g.create().collect(g.lease, signal));
  assert.equal((await g.get('CAPTURE_STATE')).cursor, 0);
  assert.equal(await g.get('CAPTURE#000001'), undefined);
});
test('lost transaction response recovers canonical receipts without a second score or capture cursor', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const uncertain = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as TransactWriteCommand, options as never);
      if (command instanceof TransactWriteCommand) throw new Error('response lost');
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const recorder = f.create(uncertain);
  await recorder.baseline(f.lease, signal);
  await recorder.collect(f.lease, signal);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 2);
  assert.equal(f.objects.size, 2);
});
test('final drain paginates all sealed commands and captures the cutoff-open command', async () => {
  const f = await fixture();
  const first = (await f.get('COMMAND#000001')) as CommandEvidence;
  for (let seq = 1; seq < 46; seq++)
    await f.put(`COMMAND#${String(seq).padStart(6, '0')}`, { ...first, seq, id: commandId(f.source, seq) });
  const active = { ...first, seq: 46, id: commandId(f.source, 46), endedAt: null, exitStatus: null };
  const parser = {
    ...initialCommandParser(f.source),
    count: 46,
    active: { event: active, marked: true, fullScreen: false },
  };
  await f.create().baseline(f.lease, new AbortController().signal);
  await f.create().collect(f.lease, new AbortController().signal, parser);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 46);
  assert.equal(f.calls(), 46);
  assert.equal(f.objects.size, 46);
  await f.create().collect(f.lease, new AbortController().signal, parser);
  assert.equal(f.calls(), 46);
});
test('missing command sequence cannot be converted to a complete capture cursor', async () => {
  const f = await fixture();
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: f.key('COMMAND#000001') }));
  await f.create().baseline(f.lease, new AbortController().signal);
  await assert.rejects(f.create().collect(f.lease, new AbortController().signal));
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 0);
});
test('wrong command identity and total-byte overflow fail before publication', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const client = {
    ...f.client,
    capture: async (v: Parameters<CaptureClient['capture']>[0]) => ({
      ...(await f.client.capture(v)),
      commandId: randomUUID(),
    }),
  };
  await f.create().baseline(f.lease, signal);
  await assert.rejects(f.create(database.document, client).collect(f.lease, signal));
  assert.equal(f.objects.size, 0);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 0);
  await f.put('CAPTURE_STATE', { ...(await f.get('CAPTURE_STATE')), retainedBytes: 20_000_000 });
  await assert.rejects(f.create().collect(f.lease, signal));
  assert.equal(f.objects.size, 0);
});

test('baseline and capture transactions retry pure contention with exact request tokens', async () => {
  const f = await fixture();
  const attempts = new Map<string, number>();
  const retrying = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) {
        const token = command.input.ClientRequestToken!;
        const count = (attempts.get(token) ?? 0) + 1;
        attempts.set(token, count);
        if (count === 1)
          throw Object.assign(new Error('conflict'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
          });
      }
      return database.document.send(command as TransactWriteCommand, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const recorder = f.create(retrying);
  const signal = new AbortController().signal;
  await recorder.baseline(f.lease, signal);
  await recorder.collect(f.lease, signal);
  assert.deepEqual([...attempts.values()], [2, 2, 2]);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 2);
  assert.equal(f.calls(), 2);
});

test('exhausted and mixed capture conflicts are typed and do not advance the saved cursor', async () => {
  for (const mixed of [false, true]) {
    const f = await fixture();
    const signal = new AbortController().signal;
    await f.create().baseline(f.lease, signal);
    let attempts = 0;
    const conflicting = {
      send: async (command: unknown, options: unknown) => {
        if (command instanceof TransactWriteCommand) {
          attempts++;
          throw Object.assign(new Error('conflict'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: mixed ? 'ConditionalCheckFailed' : 'None' }],
          });
        }
        return database.document.send(command as TransactWriteCommand, options as never);
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(
      f.create(conflicting).collect(f.lease, signal),
      (error: unknown) => error instanceof TerminalRecordingStoreError && error.code === 'conflict',
    );
    assert.equal(attempts, mixed ? 1 : 4);
    assert.equal((await f.get('CAPTURE_STATE')).cursor, 0);
    assert.equal(await f.get('CAPTURE#000001'), undefined);
  }
});

test('bounded incomplete capture excerpts do not reject an otherwise complete capture frontier', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const terminal = initialTerminalCheckpoint(terminalReady({ startedAt: at, observedAt: at, source: f.source }));
  const parser = { ...initialCommandParser(f.source), count: 2 };
  await f.put('TERMINAL_RECORDING', terminal);
  const client: CaptureClient = {
    ...f.client,
    capture: async (request) => ({
      ...(await f.client.capture(request)),
      logs: [{ path: '/var/log/nginx/access.log', lines: Array.from({ length: 200 }, () => 'request') }],
      incomplete: true,
    }),
  };
  const recorder = f.create(database.document, client);
  await recorder.baseline(f.lease, signal);
  await recorder.finish(f.lease, terminal, at, signal, parser);
  assert.equal((await f.get('CAPTURE_COVERAGE')).captures.cursor, 2);
  assert.equal((await f.get('CAPTURE#000001')).incomplete, true);
});

test('unavailable baselines, files, and metrics remain sticky and prevent capture coverage', async () => {
  for (const kind of ['baseline', 'file', 'metric']) {
    const f = await fixture();
    const signal = new AbortController().signal;
    const terminal = initialTerminalCheckpoint(terminalReady({ startedAt: at, observedAt: at, source: f.source }));
    const parser = { ...initialCommandParser(f.source), count: 2 };
    await f.put('TERMINAL_RECORDING', terminal);
    const client: CaptureClient = {
      baseline: async () => ({ baselineAt: at, incomplete: kind === 'baseline', unavailable: kind === 'baseline' }),
      capture: async (request) => ({
        ...(await f.client.capture(request)),
        ...(request.commandSeq === 1 && kind !== 'baseline'
          ? {
              incomplete: true,
              unavailable: true,
              ...(kind === 'metric'
                ? { metrics: null }
                : { files: [{ path: '/etc/config', before: 'before', after: null }] }),
            }
          : {}),
      }),
    };
    const recorder = f.create(database.document, client);
    await recorder.baseline(f.lease, signal);
    await assert.rejects(
      recorder.finish(f.lease, terminal, at, signal, parser),
      (error: unknown) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_stream',
    );
    assert.equal((await f.get('CAPTURE_STATE')).unavailable, true);
    assert.equal((await f.get('CAPTURE_STATE')).cursor, 2);
    assert.equal(await f.get('CAPTURE_COVERAGE'), undefined);
  }
});

test('concurrent bounded captures publish one canonical cursor and warning', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const client: CaptureClient = {
    ...f.client,
    capture: async (request) => ({ ...(await f.client.capture(request)), incomplete: true }),
  };
  const recorder = f.create(database.document, client);
  await recorder.baseline(f.lease, signal);
  await Promise.all([recorder.collect(f.lease, signal), recorder.collect(f.lease, signal)]);
  const state = await f.get('CAPTURE_STATE');
  assert.equal(state.cursor, 2);
  assert.equal(state.incomplete, true);
  assert.equal(state.unavailable, false);
  assert.equal(
    state.retainedBytes,
    [...f.objects.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  );
});

test('final captures save exact task-independent coverage before terminal sealing', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const recorder = f.create();
  const terminal = initialTerminalCheckpoint(terminalReady({ startedAt: at, observedAt: at, source: f.source }));
  await f.put('TERMINAL_RECORDING', terminal);
  const parser = { ...initialCommandParser(f.source), count: 2 };
  await recorder.baseline(f.lease, signal);
  await recorder.finish(f.lease, terminal, at, signal, parser);
  const receipt = await f.get('CAPTURE_COVERAGE');
  assert.deepEqual(receipt.parser, parser);
  assert.deepEqual(receipt.terminal, terminal);
  assert.equal(receipt.captures.cursor, 2);
  assert.equal(await f.get('TERMINAL_SEAL'), undefined);
  await recorder.finish(f.lease, terminal, at, signal, parser);
  assert.equal(f.calls(), 2);
});

test('invalid published command evidence is a typed session failure', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  await f.create().baseline(f.lease, signal);
  await f.put('COMMAND#000001', { schemaVersion: 99 });
  await assert.rejects(
    f.create().collect(f.lease, signal),
    (error: unknown) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_store',
  );
  assert.equal(f.calls(), 0);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 0);
});

test('capture coverage fences further captures and duplicate finish needs no Monitor', async () => {
  const f = await fixture();
  const signal = new AbortController().signal;
  const terminal = initialTerminalCheckpoint(terminalReady({ startedAt: at, observedAt: at, source: f.source }));
  const parser = { ...initialCommandParser(f.source), count: 2 };
  await f.put('TERMINAL_RECORDING', terminal);
  await f.create().baseline(f.lease, signal);
  await f.create().finish(f.lease, terminal, at, signal, parser);
  const frozen = await f.get('CAPTURE_STATE');
  const first = (await f.get('COMMAND#000001')) as CommandEvidence;
  await f.put('COMMAND#000003', { ...first, seq: 3, id: commandId(f.source, 3) });
  await f.put('COMMAND_PARSER', { ...parser, count: 3 });
  await assert.rejects(
    f.create().collect(f.lease, signal),
    (error: unknown) => error instanceof TerminalRecordingStoreError && error.code === 'conflict',
  );
  assert.deepEqual(await f.get('CAPTURE_STATE'), frozen);
  assert.equal(await f.get('CAPTURE#000003'), undefined);
  const unavailable = {
    baseline: async () => {
      throw new Error('Monitor is stopped');
    },
    capture: async () => {
      throw new Error('Monitor is stopped');
    },
  };
  await f.create(database.document, unavailable).finish(f.lease, terminal, at, signal, parser);
});

test('capture pagination follows large command publications across an interior cursor', async () => {
  const f = await fixture();
  const first = (await f.get('COMMAND#000001')) as CommandEvidence;
  const commands = Array.from({ length: 45 }, (_, index) => ({
    ...first,
    seq: index + 1,
    id: commandId(f.source, index + 1),
  }));
  const publication = await stageCommandEvidence(
    database.document,
    f.table,
    f.id,
    'COMMAND',
    commands,
    [],
    new AbortController().signal,
  );
  await f.put('COMMAND#000001', publication);
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: f.key('COMMAND#000002') }));
  await f.put('COMMAND_PARSER', { ...initialCommandParser(f.source), count: 45 });
  const recorder = f.create();
  const signal = new AbortController().signal;
  await recorder.baseline(f.lease, signal);
  await recorder.collect(f.lease, signal);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 20);
  await recorder.collect(f.lease, signal);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 40);
  await recorder.collect(f.lease, signal);
  assert.equal((await f.get('CAPTURE_STATE')).cursor, 45);
  assert.equal(f.calls(), 45);
});
