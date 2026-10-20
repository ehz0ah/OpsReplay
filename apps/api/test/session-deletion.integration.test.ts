import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { SessionDeletion, deletionQuietMs } from '../src/delete-session/service.js';
import { createDeletionHandler } from '../src/delete-session/handler.js';
import { sessionRecord } from './session-fixture.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { initialSessionLifecycle } from '../../../packages/contracts/private/session-lifecycle.js';
import { historyKey } from '../../../packages/session/src/history.js';
import { HistoryReader } from '../src/history/reader.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());
const signal = () => AbortSignal.timeout(30_000);
const at = '2026-10-21T00:00:00.000Z';
async function fixture() {
  const id = randomUUID(),
    table = 'delete-' + randomUUID(),
    saved = sessionRecord(id),
    owner = saved.ownerId,
    request = randomUUID();
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
  saved.view.status = 'ended';
  saved.view.statusReason = 'learner_ended';
  saved.view.readyAt = '2026-10-10T08:00:00.000Z';
  saved.view.hints.nextAvailableAt = '2026-10-10T08:03:00.000Z';
  saved.view.endedAt = '2026-10-10T08:10:00.000Z';
  saved.view.endsAt = '2026-10-10T08:20:00.000Z';
  saved.view.debriefAvailable = true;
  saved.view.recording = { status: 'incomplete', reason: 'task_lost' };
  const Key = (SK: string) => ({ PK: 'SESSION#' + id, SK });
  const put = (Key: object, data: unknown, extra = {}) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...Key, data, ...extra } }));
  const get = async (Key: object) =>
    (await database.document.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
  await put(Key('STATE'), saved);
  await put(Key('LIFECYCLE'), {
    ...initialSessionLifecycle(id, saved.view.createdAt),
    readyAt: saved.view.readyAt,
    terminalSource: randomUUID(),
    lastSeenAt: saved.view.readyAt,
    lastMonitorAt: saved.view.endedAt,
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    taskStoppedAt: saved.view.endedAt,
    schedulesDeleted: true,
  });
  await put(Key('RECORDING'), {
    schemaVersion: 1,
    status: 'incomplete',
    recorderId: null,
    generation: 1,
    leaseExpiresAt: null,
    startedAt: saved.view.readyAt,
    source: null,
    cursor: 0,
    cutoffAt: saved.view.endedAt,
    drainDeadlineAt: saved.view.endedAt,
    sealed: null,
    retainUntil: '2026-10-17T08:00:00.000Z',
    reason: 'task_lost',
    updatedAt: saved.view.endedAt,
    completedAt: saved.view.endedAt,
  });
  await put(Key('PLAYBACK_EXPORT'), {
    schemaVersion: 1,
    cutoffAt: saved.view.endedAt,
    sourceSha256: 'a'.repeat(64),
    terminalCursor: 0,
    terminalBytes: 0,
    terminalCount: 0,
    terminalLastAt: null,
    columns: 80,
    rows: 24,
    utf8Tail: '',
    inputTail: '',
    markerPrefix: '',
    markerDiscard: false,
    markerEscaped: false,
    terminalDone: true,
    metricCursor: 0,
    metricScanKey: null,
    metricBytes: 0,
    metricCount: 0,
    metricLastAt: null,
    metricsDone: true,
    complete: true,
    unavailable: null,
  });
  const receipt = { PK: 'USER#' + owner, SK: 'START#' + request },
    history = historyKey(owner, 'session', saved.view.createdAt, id);
  await put(receipt, { ownerId: owner, sessionId: id, requestId: request, hash: 'a'.repeat(64) });
  await put(history, { schemaVersion: 1, id, at: saved.view.createdAt });
  const objects = new Set([
    `sessions/${id}/terminal/one`,
    `sessions/${id}/metrics/two`,
    `sessions/${randomUUID()}/keep`,
  ]);
  const events: string[] = [];
  let failDelete = false,
    failTable = false,
    now = Date.parse(at),
    versioned = false;
  const s3 = {
    send: async (command: unknown) => {
      if (command instanceof GetBucketVersioningCommand) return versioned ? { Status: 'Suspended' } : {};
      if (command instanceof ListObjectsV2Command)
        return { Contents: [...objects].filter((k) => k.startsWith(command.input.Prefix!)).map((Key) => ({ Key })) };
      if (command instanceof DeleteObjectsCommand) {
        events.push('s3_delete');
        if (failDelete) return { Errors: [{ Code: 'AccessDenied' }] };
        for (const value of command.input.Delete!.Objects!) objects.delete(value.Key!);
        return {};
      }
      throw new Error('Unexpected S3 call');
    },
  } as unknown as S3Client;
  const db = {
    send: async (command: any, options: any) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some((v) => v.Delete && v.Delete.Key?.SK !== 'STATE')
      ) {
        events.push('table_delete');
        if (failTable) throw new Error('Injected write loss');
      }
      return database.document.send(command, options);
    },
  } as unknown as DynamoDBDocumentClient;
  return {
    id,
    table,
    saved,
    owner,
    Key,
    put,
    get,
    receipt,
    history,
    objects,
    events,
    s3,
    now: () => now,
    service: new SessionDeletion(db, table, s3, 'recordings', () => now),
    advance: () => {
      now += deletionQuietMs;
    },
    failS3: (v: boolean) => {
      failDelete = v;
    },
    failDb: (v: boolean) => {
      failTable = v;
    },
    versioned: () => {
      versioned = true;
    },
  };
}
test('deletion fences reads, waits for late writes, deletes objects first and preserves unrelated data', async () => {
  const f = await fixture(),
    other = randomUUID(),
    active = { PK: 'USER#' + f.owner, SK: 'ACTIVE' };
  await f.put(active, { sessionId: other, requestId: randomUUID() });
  const progress = { PK: 'USER#' + f.owner, SK: 'PROGRESS#wrong-upstream-port' };
  await f.put(progress, { completedAttempts: 1 });
  for (let n = 0; n < 205; n++) await f.put(f.Key('COMMAND#' + n.toString().padStart(6, '0')), { text: 'private' });
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'pending');
  assert.equal(await f.get(f.Key('STATE')), undefined);
  assert.ok(await f.get(f.Key('DELETION')));
  assert.equal(f.events.includes('s3_delete'), false);
  const page = await new HistoryReader(database.document, f.table).page(
    {} as APIGatewayProxyEvent,
    f.owner,
    'session',
    signal(),
  );
  assert.deepEqual(page.items, []);
  f.objects.add(`sessions/${f.id}/playback/late`);
  f.advance();
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'deleted');
  assert.equal(f.events[0], 's3_delete');
  assert.equal((await f.get(active))?.data.sessionId, other);
  assert.deepEqual((await f.get(progress))?.data, { completedAttempts: 1 });
  assert.equal(await f.get(f.history), undefined);
  assert.equal(await f.get(f.receipt), undefined);
  assert.equal(f.objects.size, 1);
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'absent');
});
test('ownership, unfinished work, versioned buckets and active locks reject before deletion', async () => {
  for (const variant of ['owner', 'active', 'work', 'playback', 'versioned'] as const) {
    const f = await fixture();
    if (variant === 'active')
      await f.put({ PK: 'USER#' + f.owner, SK: 'ACTIVE' }, { sessionId: f.id, requestId: randomUUID() });
    if (variant === 'work')
      await f.put(f.Key('TURN#' + randomUUID()), { text: 'private' }, { WorkPK: 'ASSISTANT', WorkSK: at });
    if (variant === 'playback') await f.put(f.Key('PLAYBACK_EXPORT'), { incomplete: true });
    if (variant === 'versioned') f.versioned();
    await assert.rejects(f.service.run(variant === 'owner' ? 'someone-else' : f.owner, f.id, signal()));
    assert.ok(await f.get(f.Key('STATE')));
    assert.equal(await f.get(f.Key('DELETION')), undefined);
    assert.deepEqual(f.events, []);
  }
});
test('partial S3 and table failure preserve the marker and resume without claiming success', async () => {
  const f = await fixture();
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'pending');
  f.advance();
  f.failS3(true);
  await assert.rejects(f.service.run(f.owner, f.id, signal()), { code: 'CONFLICT' });
  assert.ok(await f.get(f.Key('RECORDING')));
  assert.ok(await f.get(f.receipt));
  f.failS3(false);
  f.failDb(true);
  await assert.rejects(f.service.run(f.owner, f.id, signal()));
  assert.ok(await f.get(f.Key('DELETION')));
  assert.ok(await f.get(f.receipt));
  f.failDb(false);
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'deleted');
});
test('lost final transaction response can be retried after atomic reference removal', async () => {
  const f = await fixture();
  await f.service.run(f.owner, f.id, signal());
  f.advance();
  const db = {
    send: async (command: any, options: any) => {
      const result = await database.document.send(command, options);
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some((v) => v.Delete?.Key?.SK === 'DELETION')
      )
        throw new Error('Lost response');
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  await assert.rejects(
    new SessionDeletion(db, f.table, f.s3, 'recordings', f.now).run(f.owner, f.id, signal()),
    /Lost response/,
  );
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'absent');
  await f.put(f.Key('COMMAND#orphan'), { text: 'private' });
  await assert.rejects(f.service.run(f.owner, f.id, signal()), { code: 'CONFLICT' });
});
test('competing claims preserve one marker and a repeat resumes it', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.service.run(f.owner, f.id, signal()),
    f.service.run(f.owner, f.id, signal()),
  ]);
  assert.ok(results.some((r) => r.status === 'fulfilled' && r.value === 'pending'));
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'pending');
  await assert.rejects(f.service.run('wrong-owner', f.id, signal()), { code: 'INVALID_STORE' });
  f.advance();
  assert.equal(await f.service.run(f.owner, f.id, signal()), 'deleted');
});
test('operator handler validates exact payload and hides provider errors', async () => {
  const handler = createDeletionHandler({
    run: async () => {
      throw new Error('secret from SDK');
    },
  });
  const context = { getRemainingTimeInMillis: () => 5000 };
  assert.deepEqual(
    await handler({ operation: 'delete_session', ownerId: 'x', sessionId: randomUUID(), extra: 1 }, context),
    { status: 'rejected', code: 'INVALID_REQUEST' },
  );
  assert.deepEqual(await handler({ operation: 'delete_session', ownerId: 'x', sessionId: randomUUID() }, context), {
    status: 'rejected',
    code: 'RETRY_REQUIRED',
  });
});
