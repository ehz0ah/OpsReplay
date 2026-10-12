import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { terminalSessionKey } from '../../../packages/contracts/private/terminal-access.js';
import { createGetSessionHandler } from '../src/get-session/handler.js';
import { DynamoSessionReader, type SessionReader } from '../src/get-session/store.js';
import { createMonitorCertificate } from '../src/session-lifecycle/monitor-certificate.js';
import { publicView } from '../src/shared/session-view.js';
import type { SessionRecord, SessionView } from '../src/start-session/types.js';
import { validSession, validSessionRelations, validView } from '../src/start-session/validation.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { sessionRecord } from './session-fixture.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

const ownerId = sessionRecord(randomUUID()).ownerId;
const otherOwnerId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const context = { awsRequestId: requestId, getRemainingTimeInMillis: () => 10_000 };
const certificate = (await createMonitorCertificate(sessionRecord(randomUUID()))).certificate;
const bodyOf = (value: { body: string }) => JSON.parse(value.body);

function withStatus(id: string, status: SessionView['status']): SessionRecord {
  const session = sessionRecord(id);
  session.view.status = status;
  if (status !== 'provisioning') {
    session.monitorCertificate = certificate;
    session.taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    session.taskAddress = '10.0.1.42';
    session.view.readyAt = '2026-10-10T07:59:00.000Z';
    session.view.endsAt = '2026-10-10T08:19:00.000Z';
    session.view.recovery = {
      state: status === 'resolved' ? 'met' : 'failing',
      sustainedSeconds: status === 'resolved' ? 60 : 0,
      requiredSeconds: 60,
    };
    session.view.recording.status = status === 'ready' ? 'recording' : 'draining';
  }
  if (status !== 'provisioning' && status !== 'ready') {
    const reasons = {
      resolved: 'validators_passed',
      failed: 'time_limit',
      ended: 'learner_ended',
      abandoned: 'heartbeat_missed',
      error: 'environment_exited',
    } as const;
    session.view.statusReason = reasons[status];
    session.view.endedAt = '2026-10-10T08:00:00.000Z';
  }
  assert.ok(validSession(session), JSON.stringify(validSession.errors));
  assert.ok(validSessionRelations(session));
  return session;
}

function event(id: string, actor: unknown = ownerId): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    resource: '/v1/sessions/{id}',
    path: `/v1/sessions/${id}`,
    headers: {},
    multiValueHeaders: {},
    pathParameters: { id },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    isBase64Encoded: false,
    body: null,
    requestContext: { authorizer: { claims: { sub: actor } } },
  } as unknown as APIGatewayProxyEvent;
}

async function fixture(status: SessionView['status'] = 'provisioning') {
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
  const put = async (data: unknown, keyId = id) =>
    database.document.send(
      new PutCommand({
        TableName: table,
        Item: { ...terminalSessionKey(keyId), data },
      }),
    );
  const session = withStatus(id, status);
  await put(session);
  const logs: unknown[] = [];
  const commands: GetCommand[] = [];
  const client = {
    send: async (command: unknown, options: unknown) => {
      assert.ok(command instanceof GetCommand, 'Status must use only point reads');
      assert.equal(command.input.ConsistentRead, true);
      commands.push(command);
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoSessionReader(client, table);
  const handler = createGetSessionHandler({ store, log: (entry) => logs.push(entry) });
  const rows = async () =>
    (await database.document.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items;
  return { table, id, session, put, logs, commands, store, handler, rows };
}

test('returns the exact public view for every lifecycle state without writes', async () => {
  for (const status of ['provisioning', 'ready', 'resolved', 'failed', 'ended', 'abandoned', 'error'] as const) {
    const f = await fixture(status);
    const beforeRows = await f.rows();
    const response = await f.handler(event(f.id), context);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(bodyOf(response), f.session.view);
    assert.ok(validView(bodyOf(response)), JSON.stringify(validView.errors));
    assert.deepEqual(response.headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    assert.equal(f.commands.length, 1);
    const command = f.commands[0];
    assert.ok(command);
    assert.deepEqual(command.input.Key, terminalSessionKey(f.id));
    assert.deepEqual(await f.rows(), beforeRows);
    assert.deepEqual(Object.keys(f.logs[0] as object).sort(), ['durationMs', 'operation', 'requestId', 'result']);
  }
});

test('reads the saved Pro grant after plan expiry or content withdrawal, without other lookups', async () => {
  const f = await fixture('ready');
  f.session.accessGrant.plan = 'pro';
  f.session.view.attempt = { kind: 'retry', number: 2 };
  f.session.view.hints = {
    released: [{ id: 'hint-1', text: 'Inspect proxy logs.', releasedAt: '2026-10-10T07:59:30.000Z' }],
    remaining: 1,
    nextAvailableAt: '2026-10-10T08:02:00.000Z',
  };
  f.session.view.assistance = { hintsReleased: 1, assistantTurns: 2, proposalsRun: 1 };
  await f.put(f.session);
  await database.document.send(
    new PutCommand({
      TableName: f.table,
      Item: { PK: `USER#${ownerId}`, SK: 'PLAN', data: { plan: 'pro', expiresAt: '2026-10-01T00:00:00.000Z' } },
    }),
  );
  const response = await f.handler(event(f.id), context);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(bodyOf(response), f.session.view);
  assert.equal(f.commands.length, 1);
});

test('missing and foreign sessions have identical responses, including corrupt foreign records', async () => {
  const f = await fixture('ready');
  const missing = await f.handler(event(randomUUID()), context);
  const foreign = await f.handler(event(f.id, otherOwnerId), context);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(foreign, missing);
  await f.put({ ownerId, view: { rootCause: 'private failure' } });
  assert.deepEqual(await f.handler(event(f.id, otherOwnerId), context), missing);
});

test('polling observes saved changes and does not advance state or charge activity', async () => {
  const f = await fixture();
  assert.equal(bodyOf(await f.handler(event(f.id), context)).status, 'provisioning');
  const ready = withStatus(f.id, 'ready');
  await f.put(ready);
  assert.equal(bodyOf(await f.handler(event(f.id.toUpperCase()), context)).status, 'ready');
  const resolved = withStatus(f.id, 'resolved');
  resolved.view.recording = { status: 'incomplete', reason: 'data_gap' };
  resolved.view.debriefAvailable = true;
  await f.put(resolved);
  assert.deepEqual(bodyOf(await f.handler(event(f.id), context)), resolved.view);
  assert.deepEqual((await f.rows())?.[0]?.data, resolved);
});

test('a reused handler does not retain learner or session data between concurrent requests', async () => {
  const f = await fixture('ready');
  const secondId = randomUUID();
  const second = withStatus(secondId, 'ended');
  second.ownerId = otherOwnerId;
  second.view.alert.summary = 'A different learner alert.';
  await f.put(second, secondId);
  const responses = await Promise.all([
    f.handler(event(f.id), context),
    f.handler(event(secondId, otherOwnerId), context),
    f.handler(event(f.id, otherOwnerId), context),
    f.handler(event(secondId), context),
  ]);
  assert.deepEqual(bodyOf(responses[0]), f.session.view);
  assert.deepEqual(bodyOf(responses[1]), second.view);
  assert.equal(responses[2].statusCode, 404);
  assert.equal(responses[3].statusCode, 404);
});

test('returns each saved recording state and only allowed incomplete reasons', async () => {
  const f = await fixture('resolved');
  for (const recording of [
    { status: 'pending', reason: null },
    { status: 'recording', reason: null },
    { status: 'draining', reason: null },
    { status: 'complete', reason: null },
    ...['task_lost', 'recorder_lost', 'drain_timeout', 'limit_exceeded', 'data_gap'].map((reason) => ({
      status: 'incomplete',
      reason,
    })),
  ] as SessionView['recording'][]) {
    f.session.view.recording = recording;
    await f.put(f.session);
    const response = await f.handler(event(f.id), context);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(bodyOf(response).recording, recording);
  }
  f.session.view.recording = { status: 'incomplete', reason: 'unknown_private_reason' };
  await f.put(f.session);
  assert.equal((await f.handler(event(f.id), context)).statusCode, 500);
});

test('returns a startup error before readiness without exposing the private launch failure', async () => {
  const f = await fixture();
  f.session.view.status = 'error';
  f.session.view.statusReason = 'start_failed';
  f.session.view.endedAt = '2026-10-10T08:01:00.000Z';
  f.session.launchFailure = { kind: 'configuration', reasons: ['ATTRIBUTE'] };
  await f.put(f.session);
  const response = await f.handler(event(f.id), context);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(bodyOf(response), f.session.view);
  assert.equal(bodyOf(response).readyAt, null);
  assert.equal((response.body + JSON.stringify(f.logs)).includes('ATTRIBUTE'), false);
});

test('keeps private metadata out of responses and logs', async () => {
  const f = await fixture('ready');
  const hidden = 'hidden-scenario-data';
  await f.put({ ...f.session, rootCause: hidden, validators: [hidden], unreleasedHints: [hidden] });
  const response = await f.handler(event(f.id), context);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(bodyOf(response), f.session.view);
  const text = response.body + JSON.stringify(f.logs);
  for (const privateValue of [
    hidden,
    f.session.monitorSecret,
    certificate,
    f.session.taskAddress!,
    f.session.taskArn!,
    ownerId,
    f.session.pins.challengeImageDigest,
  ]) {
    assert.equal(text.includes(privateValue), false);
  }
});

test('corrupt owned records, mismatched IDs and access grants fail closed', async () => {
  const f = await fixture();
  const corruptions: unknown[] = [
    null,
    {},
    { ...f.session, view: undefined },
    { ...f.session, accessGrant: undefined },
    { ...f.session, accessGrant: { ...f.session.accessGrant, timeLimitSeconds: 600 } },
    { ...f.session, launchArguments: { ...f.session.launchArguments, clientToken: randomUUID() } },
    sessionRecord(randomUUID()),
    { ...f.session, view: { ...f.session.view, rootCause: 'private' } },
    { ...f.session, view: { ...f.session.view, alert: { ...f.session.view.alert, rootCause: 'private' } } },
  ];
  for (const value of corruptions) {
    // DynamoDB does not accept undefined attributes; remove them before the corruption write.
    await f.put(value === undefined ? null : JSON.parse(JSON.stringify(value)));
    const response = await f.handler(event(f.id), context);
    assert.equal(response.statusCode, 500);
    assert.deepEqual(bodyOf(response), {
      code: 'INTERNAL_ERROR',
      message: 'The session could not be read. Try again.',
      requestId,
    });
  }
});

test('public projection drops extra fields at every nested level without mutating source data', () => {
  const view = withStatus(randomUUID(), 'ready').view;
  view.hints.released = [{ id: 'hint-1', text: 'Inspect logs.', releasedAt: '2026-10-10T08:00:00.000Z' }];
  const expected = structuredClone(view);
  for (const object of [
    view,
    view.challenge,
    view.attempt,
    view.alert,
    ...view.dashboard,
    view.recovery!,
    view.hints,
    ...view.hints.released,
    view.assistance,
    view.recording,
  ]) {
    Object.assign(object, { private: 'hidden-value' });
  }
  assert.deepEqual(publicView(view), expected);
  assert.equal(JSON.stringify(view).includes('hidden-value'), true);
});

test('rejects untrusted identity and invalid requests before storage access', async () => {
  let calls = 0;
  const handler = createGetSessionHandler({
    store: {
      read: async () => {
        calls++;
        return undefined;
      },
    },
  });
  const id = randomUUID();
  for (const actor of [null, undefined, '', 'a#b', 'x'.repeat(129), { sub: ownerId }]) {
    const invalid = event(id, null);
    invalid.requestContext.authorizer = actor === undefined ? undefined : { claims: { sub: actor } };
    invalid.headers = { Authorization: 'Bearer untrusted', 'x-user-id': ownerId };
    assert.equal((await handler(invalid, context)).statusCode, 401);
  }
  for (const invalid of [
    { ...event(id), httpMethod: 'POST' },
    { ...event(id), resource: '/v1/sessions' },
    { ...event(id), pathParameters: null },
    { ...event(id), pathParameters: { id: 'not-a-session' } },
    { ...event(id), body: '{}' },
    { ...event(id), body: '' },
  ])
    assert.equal((await handler(invalid, context)).statusCode, 400);
  assert.equal(calls, 0);
});

test('storage failures and exhausted request deadlines are generic and bounded', async () => {
  let calls = 0;
  const logs: unknown[] = [];
  const store: SessionReader = {
    read: async () => {
      calls++;
      throw new Error('private storage error');
    },
  };
  const handler = createGetSessionHandler({ store, log: (entry) => logs.push(entry) });
  const failure = await handler(event(randomUUID()), context);
  assert.equal(failure.statusCode, 500);
  assert.equal((failure.body + JSON.stringify(logs)).includes('private storage error'), false);
  const expired = await handler(event(randomUUID()), { ...context, getRemainingTimeInMillis: () => 1000 });
  assert.equal(expired.statusCode, 500);
  assert.equal(calls, 1);

  const id = randomUUID();
  let signal: AbortSignal | undefined;
  const slow = createGetSessionHandler({
    store: {
      read: async (_id, _owner, abortSignal) => {
        signal = abortSignal;
        await sleep(30);
        return sessionRecord(id).view;
      },
    },
  });
  assert.equal((await slow(event(id), { ...context, getRemainingTimeInMillis: () => 1005 })).statusCode, 500);
  assert.equal(signal?.aborted, true);
});

test('the reader validates input, forwards cancellation, and rejects late results', async () => {
  assert.throws(() => new DynamoSessionReader({} as DynamoDBDocumentClient, 'x'), /Invalid session table/);
  const id = randomUUID();
  let calls = 0;
  const controller = new AbortController();
  const client = {
    send: async (_command: unknown, options: { abortSignal?: AbortSignal }) => {
      calls++;
      assert.equal(options.abortSignal, controller.signal);
      controller.abort();
      return { Item: { data: sessionRecord(id) } };
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoSessionReader(client, 'test-unused');
  await assert.rejects(store.read('invalid', ownerId), /Invalid session read/);
  await assert.rejects(store.read(id.toUpperCase(), ownerId), /Invalid session read/);
  await assert.rejects(store.read(id, 'bad#owner'), /Invalid session read/);
  assert.equal(calls, 0);
  await assert.rejects(store.read(id, ownerId, controller.signal), /aborted/);
  await assert.rejects(store.read(id, ownerId, controller.signal), /aborted/);
  assert.equal(calls, 1);
});

test('logging failures do not change a read result and correlation IDs are server-owned', async () => {
  const id = randomUUID();
  const handler = createGetSessionHandler({
    store: { read: async () => sessionRecord(id).view },
    log: () => {
      throw new Error('logger failed');
    },
  });
  assert.equal((await handler(event(id), context)).statusCode, 200);
  const missing = createGetSessionHandler({ store: { read: async () => undefined } });
  const invalid = event(id);
  invalid.queryStringParameters = { requestId: 'untrusted-request-id' };
  const response = await missing(invalid, { ...context, awsRequestId: 'not-a-uuid' });
  assert.match(bodyOf(response).requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.body.includes('untrusted-request-id'), false);
});

test('the bundled Lambda requires its fixed browser policy and has no development identity bypass', async () => {
  const names = ['SESSION_TABLE_NAME', 'PUBLIC_API_ALLOWED_ORIGIN', 'COGNITO_USER_POOL_CLIENT_ID'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.SESSION_TABLE_NAME = 'test-unused';
    process.env.PUBLIC_API_ALLOWED_ORIGIN = 'https://app.opsreplay.test';
    process.env.COGNITO_USER_POOL_CLIENT_ID = 'client123';
    const bundled = createRequire(import.meta.url)('../../../dist/get-session/index.cjs');
    assert.equal((await bundled.handler(event(randomUUID(), null), context)).statusCode, 401);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
