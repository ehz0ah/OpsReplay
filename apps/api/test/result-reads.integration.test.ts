import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';
import { ResultReader } from '../src/result-reads/shared.js';
import { createGetDebriefHandler } from '../src/get-debrief/handler.js';
import { createListTimelineHandler } from '../src/list-timeline/handler.js';
import { createGetPlaybackHandler, type PlaybackSigner } from '../src/get-playback/handler.js';
import { PlaybackExporter } from '../../../packages/session/src/playback-export.js';
import { DynamoFinaliseStore } from '../../../packages/session/src/finalise-store.js';
import { RecordedEvidenceReader } from '../../../packages/session/src/recorded-evidence.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { playbackFixture, playbackEnd, playbackAt } from './playback-fixture.js';
import {
  commandId,
  initialCommandParser,
  type CommandEvidence,
} from '../../../packages/contracts/private/command-evidence.js';
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const valid = (name: string, value: unknown) => assert.ok(ajv.getSchema(`${publicSchema.$id}#/$defs/${name}`)!(value));
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60000 },
);
after(() => database?.close());
const context = { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 25000 };
const event = (
  id: string,
  route: string,
  actor: unknown,
  query: Record<string, string> | null = null,
): APIGatewayProxyEvent =>
  ({
    httpMethod: 'GET',
    resource: `/v1/sessions/{id}/${route}`,
    path: `/v1/sessions/${id}/${route}`,
    headers: {},
    multiValueHeaders: {},
    pathParameters: { id },
    queryStringParameters: query,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    isBase64Encoded: false,
    body: null,
    requestContext: { authorizer: { claims: { sub: actor } } },
  }) as unknown as APIGatewayProxyEvent;
async function fixture(pages = 2, complete = false) {
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
  const reads: (GetCommand | QueryCommand)[] = [];
  let clock = Date.parse(playbackEnd);
  let credentialExpiry: number | null = null;
  const signs: { key: string; seconds: number; at: number }[] = [];
  const objectReads: unknown[] = [];
  let missing = false;
  let badChecksum = false;
  const client = {
    send: async (command: GetCommand | QueryCommand, options: unknown) => {
      reads.push(command);
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const s3 = {
    send: async (command: GetObjectCommand | PutObjectCommand | HeadObjectCommand) => {
      objectReads.push(command);
      const key = command.input.Key!;
      if (command instanceof PutObjectCommand) {
        if (f.objects.has(key))
          throw new S3ServiceException({
            name: 'PreconditionFailed',
            $fault: 'client',
            $metadata: { httpStatusCode: 412 },
          });
        f.objects.set(key, Buffer.from(command.input.Body as Buffer));
        return {};
      }
      if (missing) throw new Error('hidden storage failure');
      const bytes = f.objects.get(key)!;
      if (command instanceof HeadObjectCommand)
        return {
          ContentLength: bytes.length,
          ChecksumSHA256: badChecksum ? 'bad' : createHash('sha256').update(bytes).digest('base64'),
        };
      return { ContentLength: bytes.length, Body: Readable.from([bytes]) };
    },
  } as unknown as S3Client;
  const signer: PlaybackSigner = {
    credentialExpiresAt: async () => credentialExpiry,
    sign: async (key, seconds, at) => {
      signs.push({ key, seconds, at: at.getTime() });
      clock += 100;
      return `https://test.invalid/${encodeURIComponent(key)}?signed=true`;
    },
  };
  await new DynamoFinaliseStore(database.document, table).commit(f.session, f.debrief);
  const exporter = new PlaybackExporter(database.document, table, s3, 'test-recordings', () => clock);
  while (!(await exporter.prepare(f.session))) {
    /* bounded passes */
  }
  const store = new ResultReader(client, table);
  const logs: unknown[] = [];
  const debrief = createGetDebriefHandler(store, (value) => logs.push(value));
  const playback = createGetPlaybackHandler(
    store,
    s3,
    'test-recordings',
    signer,
    () => clock,
    (value) => logs.push(value),
  );
  const evidence = new RecordedEvidenceReader(client, table, s3, 'test-recordings');
  const timeline = createListTimelineHandler(
    store,
    evidence,
    (value) => logs.push(value),
    () => clock,
  );
  const call = (route: string, query: Record<string, string> | null = null, actor: unknown = f.session.ownerId) =>
    ({ debrief, playback, timeline })[route as 'debrief'](event(f.id, route, actor, query), context);
  reads.length = 0;
  objectReads.length = 0;
  return {
    ...f,
    table,
    put,
    reads,
    signs,
    logs,
    objectReads,
    store,
    evidence,
    call,
    playback,
    timeline,
    clock: (at: number) => {
      clock = at;
    },
    credentials: (at: number) => {
      credentialExpiry = at;
    },
    missing: () => {
      missing = true;
    },
    badChecksum: () => {
      badChecksum = true;
    },
  };
}
test('end-to-end exports/finalisation expose public owner reads and preserve null partial score', async () => {
  const f = await fixture();
  for (const [route, type] of [
    ['debrief', 'Debrief'],
    ['timeline', 'TimelinePage'],
    ['playback', 'Playback'],
  ]) {
    const response = await f.call(route!);
    assert.equal(response.statusCode, 200, response.body);
    valid(type!, JSON.parse(response.body));
    assert.equal(response.headers?.['Cache-Control'], 'no-store');
    assert.equal(response.body.includes('monitorSecret'), false);
  }
  assert.equal(JSON.parse((await f.call('debrief')).body).score, null);
  assert.ok(f.reads.every((v) => v.input.ConsistentRead === true));
  assert.equal(JSON.stringify(f.logs).includes('signed=true'), false);
});
test('foreign, missing and invalid identity cannot read result data or create URLs', async () => {
  const f = await fixture();
  for (const route of ['debrief', 'timeline', 'playback']) {
    const before = f.reads.length;
    const response = await f.call(route, null, 'other-owner');
    assert.equal(response.statusCode, 404);
    assert.equal(f.reads.length - before, 1);
    assert.equal((await f.call(route, null, null)).statusCode, 401);
  }
  assert.equal(f.objectReads.length, 0);
  assert.equal(f.signs.length, 0);
  const missing = await f.playback(event(randomUUID(), 'playback', f.session.ownerId), context);
  assert.equal(missing.statusCode, 404);
});
test('active, pending and never-ready debrief states are explicit', async () => {
  const f = await fixture();
  await f.put('STATE', {
    ...f.session,
    view: {
      ...f.session.view,
      status: 'ready',
      statusReason: null,
      endedAt: null,
      recording: { status: 'recording', reason: null },
    },
  });
  assert.equal(JSON.parse((await f.call('debrief')).body).code, 'SESSION_ACTIVE');
  await f.put('STATE', f.session);
  assert.equal(JSON.parse((await f.call('debrief')).body).code, 'DEBRIEF_PENDING');
  await f.put('STATE', {
    ...f.session,
    view: {
      ...f.session.view,
      status: 'error',
      statusReason: 'start_failed',
      readyAt: null,
      endsAt: null,
      recovery: null,
      hints: { ...f.session.view.hints, nextAvailableAt: null },
      recording: { status: 'incomplete', reason: 'task_lost' },
    },
  });
  assert.equal((await f.call('debrief')).statusCode, 404);
});
test('pending playback has its own response and does not hide the saved debrief', async () => {
  const f = await fixture();
  await database.document.send(
    new DeleteCommand({ TableName: f.table, Key: { PK: `SESSION#${f.id}`, SK: 'PLAYBACK_EXPORT' } }),
  );
  const response = await f.call('playback');
  assert.equal(response.statusCode, 409);
  const pending = JSON.parse(response.body);
  assert.equal(pending.code, 'PLAYBACK_PENDING');
  assert.equal(pending.retryAfterSeconds, 3);
  valid('Error', pending);
  assert.equal((await f.call('debrief')).statusCode, 200);
  assert.equal(f.signs.length, 0);
});

test('corrupt export state returns an integrity error rather than normal pending', async () => {
  const f = await fixture();
  await f.put('PLAYBACK_EXPORT', { complete: false });
  const response = await f.call('playback');
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).code, 'INTERNAL_ERROR');
  assert.equal((await f.call('debrief')).statusCode, 200);
  assert.equal(f.objectReads.length, 0);
  assert.equal(f.signs.length, 0);
});

test('final timeline cursors reject a changed result snapshot', async () => {
  const f = await fixture();
  const first = await f.call('timeline', { limit: '1' });
  assert.equal(first.statusCode, 200, first.body);
  const cursor = JSON.parse(first.body).nextCursor;
  assert.ok(cursor);
  await f.put('EVENT#0000000000000#hint#1', {
    id: 'hint-one',
    at: playbackAt,
    kind: 'assistance',
    action: 'hint_released',
    refId: 'hint-1',
  });
  const response = await f.call('timeline', { cursor });
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).code, 'INVALID_CURSOR');
  valid('Error', JSON.parse(response.body));
});

test('a delayed recovery cutoff does not remove an assistance action that already occurred', async () => {
  const f = await fixture();
  const assistance = { hintsReleased: 1, assistantTurns: 0, proposalsRun: 0 };
  const releasedAt = '2026-10-12T00:01:10.000Z';
  const session = await f.store.owned(f.id, f.session.ownerId, AbortSignal.timeout(1000));
  await Promise.all([
    f.put('STATE', {
      ...session,
      view: {
        ...session.view,
        hints: {
          released: [{ id: 'read-proxy-error', text: 'Inspect the proxy error log.', releasedAt }],
          remaining: 1,
          nextAvailableAt: '2026-10-12T00:06:00.000Z',
        },
        assistance,
      },
    }),
    f.put('DEBRIEF', { ...f.debrief, assisted: true, assistance }),
    f.put('EVENT#1791763270000#hint#late', {
      id: 'hint:late',
      at: releasedAt,
      kind: 'assistance',
      action: 'hint_released',
      refId: 'read-proxy-error',
    }),
    f.put('EVENT#1791764460000#hint#after-deadline', {
      id: 'hint:after-deadline',
      at: '2026-10-12T00:21:00.000Z',
      kind: 'assistance',
      action: 'hint_released',
      refId: 'invalid-late-hint',
    }),
  ]);
  const response = await f.call('timeline');
  assert.equal(response.statusCode, 200, response.body);
  const page = JSON.parse(response.body);
  assert.ok(page.items.some((item: { id: string; at: string }) => item.id === 'hint:late' && item.at > playbackEnd));
  assert.equal(
    page.items.some((item: { id: string }) => item.id === 'hint:after-deadline'),
    false,
  );
});

test('expired recording creates no links, while the saved debrief and grant remain readable', async () => {
  const f = await fixture();
  f.clock(Date.parse(f.recording.retainUntil!));
  assert.equal(JSON.parse((await f.call('playback')).body).code, 'RECORDING_EXPIRED');
  assert.equal((await f.call('debrief')).statusCode, 200);
  assert.equal(f.signs.length, 0);
  assert.equal(f.objectReads.length, 0);
});
test('near-retention and temporary-credential expiry bound every link to one actual signing time', async () => {
  for (const nearRetention of [false, true]) {
    const f = await fixture();
    const at = nearRetention ? Date.parse(f.recording.retainUntil!) - 2500 : Date.parse(playbackEnd) + 500;
    f.clock(at);
    if (!nearRetention) f.credentials(at + 20500);
    const response = await f.call('playback');
    assert.equal(response.statusCode, 200, response.body);
    const expiry = Date.parse(JSON.parse(response.body).expiresAt);
    assert.ok(expiry <= (nearRetention ? Date.parse(f.recording.retainUntil!) : at + 20500));
    assert.ok(f.signs.every((v) => v.at + v.seconds * 1000 === expiry));
    assert.ok(f.signs.every((v) => v.seconds >= 1 && v.seconds <= 300));
  }
});
test('missing or checksum-mismatched objects fail before any signing and hide storage detail', async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture();
    if (corrupt) f.badChecksum();
    else f.missing();
    const response = await f.call('playback');
    assert.equal(response.statusCode, 500);
    assert.equal(f.signs.length, 0);
    assert.equal(response.body.includes('storage'), false);
  }
});
test('playback keyset pages are bounded, nonoverlapping and cursor/session/snapshot-bound', async () => {
  const f = await fixture(60);
  const keys = new Set<string>();
  let cursor: string | undefined;
  let calls = 0;
  do {
    const response = await f.call('playback', { limit: '25', ...(cursor ? { cursor } : {}) });
    assert.equal(response.statusCode, 200, response.body);
    const page = JSON.parse(response.body);
    valid('Playback', page);
    assert.ok(page.terminal.length + page.metrics.length + page.captures.length <= 25);
    for (const track of [...page.terminal, ...page.metrics]) {
      assert.equal(keys.has(track.url), false);
      keys.add(track.url);
    }
    cursor = page.nextCursor ?? undefined;
    calls++;
  } while (cursor);
  assert.equal(keys.size, 61);
  assert.equal(calls, 3);
  assert.ok(f.reads.filter((v) => v instanceof QueryCommand).every((v) => v.input.Limit! <= 25));
  const first = JSON.parse((await f.call('playback', { limit: '1' })).body);
  assert.equal((await f.call('playback', { cursor: 'bad' })).statusCode, 400);
  const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString());
  decoded.id = randomUUID();
  assert.equal(
    (await f.call('playback', { cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') })).statusCode,
    400,
  );
});
test('capture eligibility follows command cutoff and preserves the actual drain interval', async () => {
  for (const complete of [false, true]) {
    const f = await fixture(2, complete);
    const baselineAt = '2026-10-11T23:59:59.000Z';
    const startedAt = '2026-10-12T00:01:01.000Z';
    const completedAt = '2026-10-12T00:01:02.000Z';
    for (const [seq, at] of [
      [1, playbackAt],
      [2, startedAt],
    ] as const) {
      const command: CommandEvidence = {
        id: commandId(f.source, seq),
        at,
        kind: 'command',
        seq,
        endedAt: completedAt,
        command: 'cat /etc/nginx/nginx.conf',
        exitStatus: 0,
        source: 'learner',
        changedFiles: [],
        outputExcerpt: '',
        outputTruncated: false,
        metrics: null,
      };
      await f.put(`${complete ? 'SEALED_COMMAND' : 'COMMAND'}#${String(seq).padStart(6, '0')}`, command);
      const body = Buffer.from(JSON.stringify({ commandSeq: seq, baselineAt, startedAt, completedAt }));
      const sha256 = createHash('sha256').update(body).digest('hex');
      const objectKey = `sessions/${f.id}/captures/000000001/${String(seq).padStart(6, '0')}-${sha256}.json`;
      f.objects.set(objectKey, body);
      await f.put(`CAPTURE#${String(seq).padStart(6, '0')}`, {
        schemaVersion: 1,
        objectKey,
        sha256,
        byteLength: body.length,
        commandId: command.id,
        commandSeq: seq,
        sequence: seq,
        baselineAt,
        startedAt,
        completedAt,
        incomplete: false,
      });
    }
    await f.put('CAPTURE_STATE', {
      schemaVersion: 1,
      baseline: { baselineAt, incomplete: false, unavailable: false },
      cursor: 2,
      sequence: 2,
      retainedBytes: 1000,
      incomplete: false,
      unavailable: false,
    });
    const first = await f.call('playback');
    assert.equal(first.statusCode, 200, first.body);
    const page = JSON.parse(first.body);
    valid('Playback', page);
    assert.deepEqual(
      page.captures.map(
        ({
          commandSeq,
          baselineAt: baseline,
          startedAt: start,
          completedAt: end,
        }: {
          commandSeq: number;
          baselineAt: string;
          startedAt: string;
          completedAt: string;
        }) => ({ commandSeq, baselineAt: baseline, startedAt: start, completedAt: end }),
      ),
      [{ commandSeq: 1, baselineAt, startedAt, completedAt }],
    );
    assert.equal(f.signs.filter((v) => v.key.includes('/captures/')).length, 1);
    const cursor = JSON.parse((await f.call('playback', { limit: '1' })).body).nextCursor;
    await f.put('CAPTURE_STATE', {
      schemaVersion: 1,
      baseline: { baselineAt, incomplete: false, unavailable: false },
      cursor: 2,
      sequence: 2,
      retainedBytes: 1001,
      incomplete: false,
      unavailable: false,
    });
    assert.equal((await f.call('playback', { cursor })).statusCode, 400);
  }
});
test('final Monitor receipts preserve delayed evidence; expired timeline creates no object reads', async () => {
  const f = await fixture(2, true);
  f.clock(Date.parse(f.recording.retainUntil!));
  f.missing();
  assert.deepEqual((await f.evidence.read(f.session)).counters, { totalRequests: 60, failedRequests: 30 });
  assert.equal((await f.call('debrief')).statusCode, 200);
  assert.equal((await f.call('timeline')).statusCode, 410);
  assert.equal(f.objectReads.length, 0);
});
test('duplicate parameters and base64 GET payloads are rejected before storage access', async () => {
  const f = await fixture();
  const duplicate = event(f.id, 'playback', f.session.ownerId, { limit: '1' });
  duplicate.multiValueQueryStringParameters = { limit: ['1', '2'] };
  assert.equal((await f.playback(duplicate, context)).statusCode, 400);
  const encoded = event(f.id, 'playback', f.session.ownerId);
  encoded.isBase64Encoded = true;
  assert.equal((await f.playback(encoded, context)).statusCode, 400);
  assert.equal(f.reads.length, 0);
});
test('changed source or missing selected export receipt fails before signing', async () => {
  for (const mutate of [
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      f.put('LIFECYCLE', { ...f.lifecycle, lastMonitorAt: '2026-10-12T00:00:01.000Z' }),
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await database.document.send(
        new DeleteCommand({ TableName: f.table, Key: { PK: `SESSION#${f.id}`, SK: 'PLAYBACK#terminal#000001' } }),
      );
    },
    async (f: Awaited<ReturnType<typeof fixture>>) => {
      await database.document.send(
        new DeleteCommand({ TableName: f.table, Key: { PK: `SESSION#${f.id}`, SK: 'PLAYBACK#terminal#000002' } }),
      );
    },
    async (f: Awaited<ReturnType<typeof fixture>>) =>
      f.put('STATE', { ...f.session, accessGrant: { ...f.session.accessGrant, timeLimitSeconds: 1 } }),
  ]) {
    const f = await fixture();
    await mutate(f);
    assert.equal((await f.call('playback')).statusCode, 500);
    assert.equal(f.signs.length, 0);
  }
});
test('invalid parameters and exhausted deadlines do no storage work', async () => {
  const f = await fixture();
  for (const query of [{ limit: '0' }, { limit: '26' }, { limit: '1e1' }, { rootCause: 'please' }])
    assert.equal((await f.call('playback', query)).statusCode, 400);
  const response = await f.playback(event(f.id, 'playback', f.session.ownerId), {
    ...context,
    getRemainingTimeInMillis: () => 500,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(f.reads.length, 0);
});
test('live keyset paging reaches new events beyond 100 while recordings advance', async () => {
  const f = await fixture();
  await f.put('STATE', {
    ...f.session,
    view: {
      ...f.session.view,
      status: 'ready',
      endedAt: null,
      statusReason: null,
      recording: { status: 'recording', reason: null },
    },
  });
  const recording = {
    ...f.recording,
    status: 'recording',
    recorderId: 'worker',
    leaseExpiresAt: '2026-10-12T00:02:00.000Z',
    cutoffAt: null,
    drainDeadlineAt: null,
    retainUntil: null,
    completedAt: null,
    reason: null,
  };
  await f.put('RECORDING', recording);
  for (let n = 0; n < 125; n++)
    await f.put(`EVENT#${String(n).padStart(13, '0')}#hint#1`, {
      id: `hint-${String(n).padStart(3, '0')}`,
      at: playbackAt,
      kind: 'assistance',
      action: 'hint_released',
      refId: `hint-${n}`,
    });
  const first = JSON.parse((await f.call('timeline', { limit: '100' })).body);
  assert.equal(first.items.length, 100);
  await f.put('RECORDING', { ...recording, generation: 2, updatedAt: '2026-10-12T00:00:01.000Z' });
  await f.put('EVENT#0000000000125#hint#1', {
    id: 'hint-125',
    at: playbackAt,
    kind: 'assistance',
    action: 'hint_released',
    refId: 'hint-125',
  });
  const secondResponse = await f.call('timeline', { cursor: first.nextCursor });
  assert.equal(secondResponse.statusCode, 200, secondResponse.body);
  const second = JSON.parse(secondResponse.body);
  assert.ok(second.items.some((v: { id: string }) => v.id === 'hint-125'));
  assert.equal(
    new Set([...first.items, ...second.items].map((v: { id: string }) => v.id)).size,
    first.items.length + second.items.length,
  );
  const empty = JSON.parse((await f.call('timeline', { cursor: second.nextCursor })).body);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.nextCursor, second.nextCursor);
  await f.put('EVENT#0000000000126#hint#1', {
    id: 'hint-126',
    at: playbackAt,
    kind: 'assistance',
    action: 'hint_released',
    refId: 'hint-126',
  });
  assert.deepEqual(
    JSON.parse((await f.call('timeline', { cursor: empty.nextCursor })).body).items.map((v: { id: string }) => v.id),
    ['hint-126'],
  );
  await f.put('RECORDING', { ...recording, source: randomUUID() });
  assert.equal((await f.call('timeline', { cursor: first.nextCursor })).statusCode, 400);
});

test('live evidence uses saved parser frontier when another command commits during its query', async () => {
  const f = await fixture();
  await f.put('STATE', {
    ...f.session,
    view: {
      ...f.session.view,
      status: 'ready',
      endedAt: null,
      statusReason: null,
      recording: { status: 'recording', reason: null },
    },
  });
  await f.put('RECORDING', {
    ...f.recording,
    status: 'recording',
    recorderId: 'worker',
    leaseExpiresAt: '2026-10-12T00:02:00.000Z',
    cutoffAt: null,
    drainDeadlineAt: null,
    retainUntil: null,
    completedAt: null,
    reason: null,
  });
  await f.put('COMMAND_PARSER', initialCommandParser(f.source));
  let raced = false;
  const client = {
    send: async (command: GetCommand | QueryCommand, options: unknown) => {
      if (
        command instanceof QueryCommand &&
        command.input.ExpressionAttributeValues?.[':prefix'] === 'COMMAND#' &&
        !raced
      ) {
        raced = true;
        const evidence: CommandEvidence = {
          id: commandId(f.source, 1),
          at: playbackAt,
          kind: 'command',
          seq: 1,
          endedAt: playbackAt,
          command: 'true',
          exitStatus: 0,
          source: 'learner',
          changedFiles: [],
          outputExcerpt: '',
          outputTruncated: false,
          metrics: null,
        };
        await f.put('COMMAND#000001', evidence);
        await f.put('COMMAND_PARSER', { ...initialCommandParser(f.source), count: 1 });
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const reader = new RecordedEvidenceReader(client, f.table, {} as S3Client, 'test-recordings');
  const handler = createListTimelineHandler(new ResultReader(client, f.table), reader);
  const response = await handler(event(f.id, 'timeline', f.session.ownerId), context);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(raced, true);
  assert.equal(
    JSON.parse(response.body).items.some((v: { kind: string }) => v.kind === 'command'),
    false,
  );
  const next = await handler(event(f.id, 'timeline', f.session.ownerId), context);
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(
    JSON.parse(next.body).items.some((v: { kind: string }) => v.kind === 'command'),
    true,
  );
});

test('live timeline shows provisional lifecycle and Monitor events without debrief or private objects', async () => {
  const f = await fixture();
  await f.put('STATE', {
    ...f.session,
    view: {
      ...f.session.view,
      status: 'ready',
      endedAt: null,
      statusReason: null,
      recording: { status: 'recording', reason: null },
    },
  });
  await f.put('RECORDING', {
    ...f.recording,
    status: 'recording',
    recorderId: 'worker',
    leaseExpiresAt: '2026-10-12T00:02:00.000Z',
    cutoffAt: null,
    drainDeadlineAt: null,
    retainUntil: null,
    completedAt: null,
    reason: null,
  });
  await f.put('MONITOR_EVENTS#000001', {
    schemaVersion: 1,
    source: f.monitorSource,
    after: 0,
    nextSequence: 1,
    events: [
      {
        sequence: 1,
        recordedAt: playbackAt,
        event: {
          id: `${f.monitorSource}:1`,
          at: playbackAt,
          kind: 'monitor',
          signal: 'outage_started',
          label: 'Proxy',
        },
      },
    ],
  });
  const response = await f.call('timeline', { limit: '1' });
  assert.equal(response.statusCode, 200, response.body);
  valid('TimelinePage', JSON.parse(response.body));
  assert.equal(f.objectReads.length, 0);
  assert.equal(
    f.reads.some((v) => v instanceof GetCommand && v.input.Key!.SK === 'DEBRIEF'),
    false,
  );
  const first = JSON.parse(response.body);
  await f.put('EVENT#0000000000000#hint#1', {
    id: 'hint-one',
    at: playbackAt,
    kind: 'assistance',
    action: 'hint_released',
    refId: 'hint-1',
  });
  assert.equal((await f.call('timeline', { cursor: first.nextCursor })).statusCode, 200);
  let reads = 0;
  const changingStore = new ResultReader(
    {
      send: async (command: GetCommand | QueryCommand, options: unknown) => {
        if (command instanceof GetCommand && command.input.Key!.SK === 'RECORDING') {
          reads++;
          const current = (await database.document.send(command)).Item!.data;
          await f.put('RECORDING', { ...current, generation: current.generation + 1 });
        }
        return database.document.send(command as never, options as never);
      },
    } as unknown as DynamoDBDocumentClient,
    f.table,
  );
  const racing = createListTimelineHandler(
    changingStore,
    new RecordedEvidenceReader(changingStore.client, f.table, {} as S3Client, 'test-recordings'),
  );
  const race = await racing(event(f.id, 'timeline', f.session.ownerId), context);
  assert.equal(race.statusCode, 200, race.body);
  assert.ok(reads >= 2);
});
