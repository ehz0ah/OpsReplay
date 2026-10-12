import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from '@aws-sdk/client-s3';
import { PlaybackExporter } from '../../../packages/session/src/playback-export.js';
import {
  isPlaybackExportState,
  isPlaybackReference,
} from '../../../packages/contracts/private/playback-persistence.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { playbackFixture, playbackEnd } from './playback-fixture.js';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60000 },
);
after(() => database?.close());
async function fixture(complete = false, pages = 2) {
  const f = playbackFixture(complete, pages);
  const table = `test-${randomUUID()}`;
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
    database.document.send(new PutCommand({ TableName: table, Item: { PK: `SESSION#${f.id}`, SK, data } }));
  for (const [SK, data] of f.records) await put(SK, data);
  const get = async (SK: string) =>
    (
      await database.document.send(
        new GetCommand({ TableName: table, Key: { PK: `SESSION#${f.id}`, SK }, ConsistentRead: true }),
      )
    ).Item?.data;
  let failedPut = false;
  let conflict = false;
  const requests: unknown[] = [];
  const s3 = {
    send: async (command: GetObjectCommand | PutObjectCommand | HeadObjectCommand) => {
      requests.push(command);
      const key = command.input.Key!;
      if (command instanceof PutObjectCommand) {
        if (failedPut) throw new Error('upload failed');
        if (conflict) {
          conflict = false;
          throw new S3ServiceException({
            name: 'ConditionalRequestConflict',
            $metadata: { httpStatusCode: 409 },
            $fault: 'client',
            message: 'conflict',
          });
        }
        if (f.objects.has(key))
          throw new S3ServiceException({
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
            $fault: 'client',
            message: 'exists',
          });
        f.objects.set(key, Buffer.from(command.input.Body as Buffer));
        return {};
      }
      const body = f.objects.get(key);
      if (!body) throw new Error('missing object');
      return command instanceof HeadObjectCommand
        ? { ContentLength: body.length, ChecksumSHA256: createHash('sha256').update(body).digest('base64') }
        : { Body: Readable.from([body]), ContentLength: body.length };
    },
  } as unknown as S3Client;
  const exporter = new PlaybackExporter(database.document, table, s3, 'test-recordings', () => Date.parse(playbackEnd));
  return {
    ...f,
    table,
    put,
    get,
    requests,
    s3,
    exporter,
    fail: () => {
      failedPut = true;
    },
    conflict: () => {
      conflict = true;
    },
  };
}
test('partial and sealed exports upload immutable chunks before persisted completion', async () => {
  for (const complete of [false, true]) {
    const f = await fixture(complete);
    assert.equal(await f.exporter.prepare(f.session), true);
    const state = await f.get('PLAYBACK_EXPORT');
    assert.ok(isPlaybackExportState(state));
    assert.equal(state.complete, true);
    assert.equal(state.terminalCount, 2);
    assert.equal(state.metricCount, 1);
    for (const SK of ['PLAYBACK#terminal#000001', 'PLAYBACK#terminal#000002', 'PLAYBACK#metrics#000001']) {
      const reference = await f.get(SK);
      assert.ok(isPlaybackReference(reference, f.id));
      assert.ok(f.objects.has(reference.objectKey));
    }
    const uploads = f.requests.filter((v): v is PutObjectCommand => v instanceof PutObjectCommand);
    assert.ok(
      uploads.every(
        (v) =>
          v.input.IfNoneMatch === '*' &&
          v.input.ChecksumSHA256 &&
          v.input.Tagging?.endsWith(complete ? 'sealed' : 'provisional'),
      ),
    );
    const count = uploads.length;
    assert.equal(await f.exporter.prepare(f.session), true);
    assert.equal(f.requests.filter((v) => v instanceof PutObjectCommand).length, count);
  }
});
test('long exports resume forward from the saved checkpoint and bound each pass', async () => {
  const f = await fixture(false, 45);
  assert.equal(await f.exporter.prepare(f.session), false);
  assert.equal((await f.get('PLAYBACK_EXPORT')).terminalCursor, 20);
  const hint = await f.get('LIFECYCLE_HINT#playback');
  assert.equal(hint.terminalCursor, 20);
  const lifecycleRow = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: `SESSION#${f.id}`, SK: 'LIFECYCLE' }, ConsistentRead: true }),
  );
  assert.equal(lifecycleRow.Item!.WorkPK, 'LIFECYCLE');
  assert.equal(await f.exporter.prepare(f.session), false);
  assert.equal((await f.get('PLAYBACK_EXPORT')).terminalCursor, 40);
  assert.equal(await f.exporter.prepare(f.session), true);
  assert.equal((await f.get('PLAYBACK_EXPORT')).terminalCount, 45);
  const completedRow = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: `SESSION#${f.id}`, SK: 'LIFECYCLE' }, ConsistentRead: true }),
  );
  assert.equal(completedRow.Item!.WorkPK, undefined);
  assert.deepEqual(completedRow.Item!.data, f.lifecycle);
});
test('upload failure leaves source frontier unacknowledged and conditional conflicts retry once', async () => {
  const failed = await fixture();
  failed.fail();
  await assert.rejects(failed.exporter.prepare(failed.session));
  assert.equal((await failed.get('PLAYBACK_EXPORT')).terminalCursor, 0);
  assert.equal(await failed.get('PLAYBACK#terminal#000001'), undefined);
  const conflict = await fixture();
  conflict.conflict();
  assert.equal(await conflict.exporter.prepare(conflict.session), true);
});
test('lost transaction response and concurrent exporters recover exact receipts without duplicate advancement', async () => {
  const f = await fixture();
  let lost = false;
  const client = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as never, options as never);
      if (command instanceof TransactWriteCommand && !lost) {
        lost = true;
        throw new Error('lost response');
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const exporter = new PlaybackExporter(client, f.table, f.s3, 'test-recordings', () => Date.parse(playbackEnd));
  await Promise.allSettled([exporter.prepare(f.session), f.exporter.prepare(f.session)]);
  assert.equal(await f.exporter.prepare(f.session), true);
  assert.equal((await f.get('PLAYBACK_EXPORT')).terminalCount, 2);
});
test('changed source snapshots, invalid source identity, cleanup and integrity fail closed', async () => {
  for (const mutate of [
    async (f: Awaited<ReturnType<typeof fixture>>) => f.put('LIFECYCLE', { ...f.lifecycle, schedulesDeleted: false }),
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      f.put('TERMINAL_RECORDING', {
        ...(await f.get('TERMINAL_RECORDING')),
        metadata: { ...(await f.get('TERMINAL_RECORDING')).metadata, source: randomUUID() },
      }),
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      const key = [...f.objects.keys()][0]!;
      f.objects.set(key, Buffer.from('{}'));
    },
  ]) {
    const f = await fixture();
    await mutate(f);
    await assert.rejects(f.exporter.prepare(f.session));
  }
  const f = await fixture(false, 25);
  await f.exporter.prepare(f.session);
  await f.put('RECORDING', { ...f.recording, updatedAt: '2026-10-12T00:01:01.000Z' });
  await assert.rejects(f.exporter.prepare(f.session));
});
test('partial metric scan resumes its physical key without rescanning earlier pages', async () => {
  const f = await fixture(false, 1);
  // First commit terminal and first metric, then expand a fresh fixture's
  // durable source to many contiguous one-frame pages across generations.
  const source = f.monitorSource;
  for (let n = 1; n <= 45; n++) {
    const frameAt = `2026-10-12T00:00:${String(n).padStart(2, '0')}.000Z`;
    const frame = {
      source,
      sequence: n,
      recordedAt: frameAt,
      payload: {
        type: 'metrics',
        sample: { at: frameAt, values: { request_rate: 1 } },
        counters: { totalRequests: n, failedRequests: 0 },
        recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
      },
    };
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'monitor_page',
        sessionId: f.id,
        recorderGeneration: 1,
        startedAt: f.recording.startedAt,
        source,
        after: n - 1,
        nextSequence: n,
        frames: [frame],
      }),
    );
    const sha256 = createHash('sha256').update(body).digest('hex');
    const reference = {
      phase: 'live',
      objectKey: `sessions/${f.id}/metrics/000000001/live/${source}/${String(n).padStart(6, '0')}-${String(n).padStart(6, '0')}-${sha256}.json`,
      sha256,
      source,
      after: n - 1,
      nextSequence: n,
      frameCount: 1,
    };
    f.objects.set(reference.objectKey, body);
    await f.put(`CHUNK#${source}#000000001#${String(n).padStart(6, '0')}`, {
      schemaVersion: 1,
      kind: 'monitor_page',
      reference,
      committedAt: frameAt,
    });
  }
  await f.put('RECORDING', { ...f.recording, cursor: 45 });
  assert.equal(await f.exporter.prepare(f.session), false);
  const first = await f.get('PLAYBACK_EXPORT');
  assert.equal(first.metricCursor, 19);
  assert.ok(first.metricScanKey.endsWith('#000019'));
  assert.equal(await f.exporter.prepare(f.session), false);
  assert.equal((await f.get('PLAYBACK_EXPORT')).metricCursor, 39);
  assert.equal(await f.exporter.prepare(f.session), true);
  assert.equal((await f.get('PLAYBACK_EXPORT')).metricCount, 45);
});
test('partial export omits post-cutoff terminal records and flushes the last UTF-8 tail', async () => {
  const f = await fixture(false, 3);
  const checkpoint = await f.get('TERMINAL_RECORDING');
  const { encodeTerminalPage } = await import('../../../packages/contracts/private/terminal-persistence.js');
  const { terminalPage } = await import('../../../packages/contracts/private/test-support/terminal-fixture.js');
  for (const [key, seq, at, bytes] of [
    [2, 2, '2026-10-12T00:00:01.000Z', Buffer.from([0xf0])],
    [3, 3, '2026-10-12T00:01:01.000Z', Buffer.from('hidden after cutoff')],
  ] as const) {
    const page = terminalPage([{ type: 'output', sequence: seq, recordedAt: at, data: bytes.toString('base64') }], {
      source: f.source,
    });
    const encoded = encodeTerminalPage(f.id, 1, key - 1, page);
    f.objects.set(encoded.reference.objectKey, encoded.body);
    await f.put(`TERMINAL_CHUNK#${f.source}#${String(key).padStart(6, '0')}`, encoded.reference);
  }
  await f.put('TERMINAL_RECORDING', {
    ...checkpoint,
    metadata: { ...checkpoint.metadata, observedAt: '2026-10-12T00:01:01.000Z' },
    frontier: {
      type: 'output',
      sequence: 3,
      recordedAt: '2026-10-12T00:01:01.000Z',
      data: Buffer.from('hidden after cutoff').toString('base64'),
    },
  });
  assert.equal(await f.exporter.prepare(f.session), true);
  const ref = await f.get('PLAYBACK#terminal#000003');
  assert.ok(isPlaybackReference(ref, f.id));
  const body = f.objects.get(ref.objectKey)!.toString();
  assert.ok(body.includes('�'));
  assert.equal(body.includes('hidden after cutoff'), false);
});
test('complete export requires a terminal seal and validates every Monitor envelope, time and final receipt', async () => {
  for (const mutate of [
    (v: any) => {
      v.sessionId = randomUUID();
    },
    (v: any) => {
      v.frames[0].sequence = 2;
    },
    (v: any) => {
      v.frames[0].recordedAt = '2026-10-12T00:01:01.000Z';
    },
    (v: any) => {
      v.frames[0].payload.sample.at = '2026-10-11T23:59:59.000Z';
    },
    (v: any) => {
      v.final.counters.failedRequests = 29;
    },
  ]) {
    const f = await fixture(true);
    const value = JSON.parse(f.objects.get(f.reference.objectKey)!.toString());
    mutate(value);
    const body = Buffer.from(JSON.stringify(value));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const reference = { ...f.reference, sha256, objectKey: f.reference.objectKey.replace(f.reference.sha256, sha256) };
    f.objects.set(reference.objectKey, body);
    await f.put('RECORDING', { ...f.recording, sealed: reference });
    await assert.rejects(f.exporter.prepare(f.session));
    assert.equal((await f.get('PLAYBACK_EXPORT')).complete, false);
    assert.equal(await f.get('PLAYBACK#metrics#000001'), undefined);
  }
  const f = await fixture(true);
  await f.put('TERMINAL_SEAL', null);
  await assert.rejects(f.exporter.prepare(f.session));
  assert.equal(await f.get('PLAYBACK_EXPORT'), undefined);
});
test('empty sealed Monitor stream exports the final metric receipt without inventing frames', async () => {
  const f = await fixture(true, 1);
  const value = JSON.parse(f.objects.get(f.reference.objectKey)!.toString());
  value.frames = [];
  value.source = null;
  value.cursor = 0;
  const body = Buffer.from(JSON.stringify(value));
  const sha256 = createHash('sha256').update(body).digest('hex');
  const reference = {
    ...f.reference,
    source: null,
    nextSequence: 0,
    frameCount: 0,
    sha256,
    objectKey: `sessions/${f.id}/metrics/000000001/sealed/empty/000000-000000-${sha256}.json`,
  };
  f.objects.set(reference.objectKey, body);
  await f.put('RECORDING', { ...f.recording, source: null, cursor: 0, sealed: reference });
  await f.put('MONITOR_FINAL', {
    schemaVersion: 1,
    cutoffAt: playbackEnd,
    source: null,
    cursor: 0,
    final: value.final,
  });
  assert.equal(await f.exporter.prepare(f.session), true);
  const state = await f.get('PLAYBACK_EXPORT');
  assert.equal(state.terminalCount, 1);
  assert.equal(state.metricCount, 1);
  assert.ok(isPlaybackReference(await f.get('PLAYBACK#metrics#000000'), f.id));
});
test('a conflicting existing export object cannot advance its immutable receipt', async () => {
  const f = await fixture();
  const s3 = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof PutObjectCommand) f.objects.set(command.input.Key!, Buffer.from('wrong'));
      return f.s3.send(command as never, options as never);
    },
  } as unknown as S3Client;
  await assert.rejects(
    new PlaybackExporter(database.document, f.table, s3, 'test-recordings', () => Date.parse(playbackEnd)).prepare(
      f.session,
    ),
    /conflict/,
  );
  assert.equal((await f.get('PLAYBACK_EXPORT')).terminalCursor, 0);
  assert.equal(await f.get('PLAYBACK#terminal#000001'), undefined);
});
test('source mutation during upload cannot commit a stale export receipt', async () => {
  const f = await fixture();
  let raced = false;
  const s3 = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof PutObjectCommand && !raced) {
        raced = true;
        await f.put('LIFECYCLE', { ...f.lifecycle, lastMonitorAt: '2026-10-12T00:00:01.000Z' });
      }
      return f.s3.send(command as never, options as never);
    },
  } as unknown as S3Client;
  await assert.rejects(
    new PlaybackExporter(database.document, f.table, s3, 'test-recordings', () => Date.parse(playbackEnd)).prepare(
      f.session,
    ),
  );
  assert.equal((await f.get('PLAYBACK_EXPORT')).terminalCursor, 0);
  assert.equal(await f.get('PLAYBACK#terminal#000001'), undefined);
});
test('expired source records completion-unavailable without any object read or upload', async () => {
  const f = await fixture();
  const exporter = new PlaybackExporter(database.document, f.table, f.s3, 'test-recordings', () =>
    Date.parse(f.recording.retainUntil!),
  );
  assert.equal(await exporter.prepare(f.session), true);
  assert.equal((await f.get('PLAYBACK_EXPORT')).unavailable, 'expired');
  assert.equal(f.requests.length, 0);
});
