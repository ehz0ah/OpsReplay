import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createStartHandler, publicView } from '../src/start-session/handler.js';
import { StartStore, keys } from '../src/start-session/store.js';
import type { ContentVersion, LaunchConfiguration, SessionRecord, StartRequest } from '../src/start-session/types.js';
import { validSession, validView } from '../src/start-session/validation.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { createAwsTransport } from '../src/shared/aws.js';
import { LifecycleStore } from '../src/session-lifecycle/store.js';
import { createProvisionSession } from '../src/session-lifecycle/provision.js';
import { LaunchRejectedError } from '../src/session-lifecycle/ports.js';
import type { ProvisionResult } from '../src/session-lifecycle/provision.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => { database = await startLocalDatabase(); }, { timeout: 60_000 });
after(() => database?.close());
const current = '2026-10-05T02:00:00.000Z';
const owner = '11111111-1111-4111-8111-111111111111';
const context = {
  awsRequestId: '22222222-2222-4222-8222-222222222222',
  getRemainingTimeInMillis: () => 10_000,
};
const launchConfiguration: LaunchConfiguration = {
  clusterArn: 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test',
  subnetIds: ['subnet-0123456789abcdef0'],
  securityGroupIds: ['sg-0123456789abcdef0'],
  platformVersion: '1.4.0',
  monitorContainerName: 'monitor',
  secretBucketArn: 'arn:aws:s3:::test-secrets',
};
const request = (): StartRequest => ({ requestId: randomUUID(), challengeId: 'wrong-upstream-port', challengeVersion: '0.1.0' });
function event(body: unknown, actor: unknown = owner): APIGatewayProxyEvent {
  // Synthetic API Gateway event. No development identity exists in the deployed handler.
  return {
    httpMethod: 'POST', resource: '/v1/sessions', path: '/v1/sessions',
    headers: {}, multiValueHeaders: {}, pathParameters: null, queryStringParameters: null,
    multiValueQueryStringParameters: null, stageVariables: null, isBase64Encoded: false,
    body: JSON.stringify(body), requestContext: { authorizer: { claims: { sub: actor } } },
  } as unknown as APIGatewayProxyEvent;
}
function content(): ContentVersion {
  return {
    mode: 'challenge', status: 'published', plan: 'free',
    challenge: { id: 'wrong-upstream-port', version: '0.1.0', title: 'Storefront returns 502', tier: 'easy', category: 'networking' },
    alert: { title: 'Checkout errors', summary: 'Checkout requests fail.', severity: 'critical' },
    dashboard: [{ id: 'error_rate', label: 'Errors', unit: 'percent' }],
    hintCount: 2, timeLimits: { free: 1200, pro: 1800 },
    // Synthetic publication pins for tests only. The repository Challenge remains a draft.
    pins: { taskDefinitionArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      challengeImageDigest: `sha256:${'a'.repeat(64)}`, monitorImageDigest: `sha256:${'b'.repeat(64)}` },
  };
}
type Store = Pick<StartStore, 'receipt' | 'session' | 'active' | 'snapshot' | 'commit'>;
async function fixture() {
  const table = `test-${randomUUID()}`;
  await database.client.send(new CreateTableCommand({
    TableName: table, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
  }));
  const put = (key: { PK: string; SK: string }, data: unknown) => database.document.send(new PutCommand({ TableName: table, Item: { ...key, data } }));
  const remove = (key: { PK: string; SK: string }) => database.document.send(new DeleteCommand({ TableName: table, Key: key }));
  const get = async (key: { PK: string; SK: string }) => (await database.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item?.data;
  const rows = async () => (await database.document.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? [];
  await put(keys.content('wrong-upstream-port', '0.1.0'), content());
  const store = new StartStore(database.document, table);
  const logs: unknown[] = [];
  const provisions: string[] = [];
  const defaultProvision = async (sessionId: string) => {
    provisions.push(sessionId);
    const saved = await store.session(sessionId);
    assert.ok(saved);
    return saved;
  };
  const makeHandler = (overrides: Partial<Store> = {},
    provision: (sessionId: string, abortSignal?: AbortSignal) => Promise<ProvisionResult> = defaultProvision) => createStartHandler({
    store: {
      receipt: store.receipt.bind(store), session: store.session.bind(store), active: store.active.bind(store),
      snapshot: store.snapshot.bind(store), commit: store.commit.bind(store), ...overrides,
    },
    launchConfiguration, provision,
    now: () => new Date(current), newSecret: () => 's'.repeat(43), log: entry => logs.push(entry),
  });
  return { table, store, put, remove, get, rows, logs, provisions, defaultProvision, makeHandler, handler: makeHandler() };
}
const bodyOf = (response: { body: string }) => JSON.parse(response.body);

test('valid admission writes the session, receipt, and lock atomically', async () => {
  const f = await fixture();
  const input = request();
  const response = await f.handler(event(input), context);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers?.['Cache-Control'], 'no-store');
  const { session, replayed } = bodyOf(response);
  assert.equal(replayed, false);
  assert.ok(validView(session));
  assert.equal(session.status, 'provisioning');
  assert.equal(session.readyAt, null);
  assert.equal(session.hints.remaining, 2);
  assert.deepEqual(session.hints.released, []);
  assert.deepEqual(session.attempt, { kind: 'first', number: 1 });
  const saved = await f.store.session(session.id);
  assert.ok(validSession(saved));
  assert.equal(saved.accessGrant.plan, 'free');
  assert.equal(saved.provisioningDeadline, '2026-10-05T02:03:00.000Z');
  assert.equal(saved.launchRecoveryDeadline, '2026-10-05T02:08:00.000Z');
  assert.equal(saved.launchArguments.clientToken, session.id);
  assert.equal(saved.launchArguments.startedBy, session.id);
  assert.equal(JSON.stringify(saved.launchArguments).includes(saved.monitorSecret), false);
  assert.equal(saved.launchArguments.overrides.containerOverrides[0].environmentFiles[0].value,
    `arn:aws:s3:::test-secrets/sessions/${session.id}.env`);
  assert.equal(saved.taskArn, null);
  assert.deepEqual(saved.provisioningCleanup, { status: 'pending', completedAt: null });
  assert.deepEqual(saved.pins, content().pins);
  assert.equal((await f.store.active(owner))?.sessionId, session.id);
  assert.equal((await f.store.receipt(owner, input.requestId))?.sessionId, session.id);
  assert.deepEqual(f.provisions, [session.id]);
  assert.equal((await f.rows()).length, 4); // One content fixture plus three admission writes.
  assert.equal(/taskDefinition|sha256|ownerId|accessGrant|pins/.test(response.body), false);
  assert.deepEqual(Object.keys(f.logs[0] as object).sort(), ['durationMs', 'operation', 'requestId', 'result']);
});

test('whitespace, property order, and UUID case do not create a new request', async () => {
  const f = await fixture();
  const input = request();
  const first = bodyOf(await f.handler(event(input), context));
  const next = event(input);
  next.body = JSON.stringify({ challengeVersion: input.challengeVersion, requestId: input.requestId.toUpperCase(), challengeId: input.challengeId }, null, 2);
  const second = bodyOf(await f.handler(next, context));
  assert.equal(second.replayed, true);
  assert.deepEqual(second.session, first.session);
  assert.equal((await f.rows()).length, 4);
});

test('a saved receipt is resolved before publication, plan, and attempt limits', async () => {
  const f = await fixture();
  const input = request();
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: null });
  const first = bodyOf(await f.handler(event(input), context));
  await f.remove(keys.content(input.challengeId, input.challengeVersion));
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: '2026-01-01T00:00:00Z' });
  await f.put(keys.progress(owner, input.challengeId), { completedAttempts: 1000 });
  const response = await f.handler(event(input), context);
  assert.equal(response.statusCode, 200);
  assert.equal(bodyOf(response).replayed, true);
  assert.deepEqual(bodyOf(response).session, first.session);
});

test('same request ID with different content conflicts before checking new content', async () => {
  const f = await fixture();
  const input = request();
  await f.handler(event(input), context);
  const response = await f.handler(event({ ...input, challengeVersion: '99.0.0' }), context);
  assert.equal(response.statusCode, 409);
  assert.equal(bodyOf(response).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.rows()).length, 4);
});

test('a receipt committed during access checks wins over a new-operation rejection', async () => {
  const f = await fixture();
  const input = request();
  let snapshotReads = 0;
  const handler = f.makeHandler({ snapshot: async (actor, start) => {
    if (++snapshotReads === 1) {
      assert.equal((await f.handler(event(input), context)).statusCode, 200);
      await f.remove(keys.content(input.challengeId, input.challengeVersion));
    }
    return f.store.snapshot(actor, start);
  } });
  const response = await handler(event(input), context);
  assert.equal(response.statusCode, 200);
  assert.equal(bodyOf(response).replayed, true);
  assert.equal((await f.rows()).length, 3);
});

test('identity and request validation reject bad input before any database access', async () => {
  const fail = async (): Promise<never> => { throw new Error('Database must not be called'); };
  const handler = createStartHandler({
    store: { receipt: fail, session: fail, active: fail, snapshot: fail, commit: fail },
    launchConfiguration, provision: fail,
  });
  for (const actor of [null, '', 'a#b', { sub: owner }, 'x'.repeat(129)]) {
    assert.equal((await handler(event(request(), actor), context)).statusCode, 401);
  }
  const spoof = event(request(), null);
  spoof.headers = { Authorization: 'Bearer fake', 'x-user-id': owner };
  assert.equal((await handler(spoof, context)).statusCode, 401);
  for (const body of [null, [], {}, { ...request(), userId: owner }, { ...request(), requestId: 'bad' },
    { ...request(), challengeId: '../private' }, { ...request(), challengeVersion: 'latest' }]) {
    assert.equal((await handler(event(body), context)).statusCode, 400);
  }
  for (const body of ['{', ' '.repeat(13_000), JSON.stringify('é'.repeat(6000))]) {
    assert.equal((await handler({ ...event(request()), body }, context)).statusCode, 400);
  }
  assert.equal((await handler({ ...event(request()), httpMethod: 'GET' }, context)).statusCode, 400);
  assert.equal((await handler({ ...event(request()), resource: '/v1/me' }, context)).statusCode, 400);
  assert.equal((await handler({ ...event(request()), isBase64Encoded: true, body: '!!!' }, context)).statusCode, 400);
});

test('base64 API Gateway bodies use the same contract', async () => {
  const f = await fixture();
  const input = request();
  const response = await f.handler({ ...event(input), isBase64Encoded: true, body: Buffer.from(JSON.stringify(input)).toString('base64') }, context);
  assert.equal(response.statusCode, 200);
});

test('missing, draft, retired, and mismatched content cannot start', async () => {
  for (const version of [undefined, { ...content(), status: 'draft' }, { ...content(), status: 'retired' },
    { ...content(), challenge: { ...content().challenge, version: '0.2.0' } }]) {
    const f = await fixture();
    if (version) await f.put(keys.content('wrong-upstream-port', '0.1.0'), version);
    else await f.remove(keys.content('wrong-upstream-port', '0.1.0'));
    const response = await f.handler(event(request()), context);
    assert.equal(response.statusCode, 422);
    assert.equal(await f.store.active(owner), undefined);
  }
});

test('Pro content requires a current grant, including at the exact expiry boundary', async () => {
  for (const expiresAt of [undefined, '2026-01-01T00:00:00Z', current]) {
    const f = await fixture();
    await f.put(keys.content('wrong-upstream-port', '0.1.0'), { ...content(), plan: 'pro' });
    if (expiresAt) await f.put(keys.plan(owner), { plan: 'pro', expiresAt });
    const response = await f.handler(event(request()), context);
    assert.equal(response.statusCode, 403);
    assert.equal(await f.store.active(owner), undefined);
  }
  const f = await fixture();
  await f.put(keys.content('wrong-upstream-port', '0.1.0'), { ...content(), plan: 'pro' });
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: '2026-10-06T00:00:00Z' });
  const response = await f.handler(event(request()), context);
  assert.equal(response.statusCode, 200);
  assert.equal(bodyOf(response).session.timeLimitSeconds, 1800);
});

test('bad stored data fails closed without exposing it', async () => {
  const f = await fixture();
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: 'secret invalid timestamp' });
  const response = await f.handler(event(request()), context);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('secret'), false);
  assert.equal(JSON.stringify(f.logs).includes('secret'), false);
  assert.equal(await f.store.active(owner), undefined);
});

test('published content requires a configured Pro extension for every learner', async () => {
  for (const pro of [null, 1200, 900]) {
    for (const learnerPlan of ['free', 'pro']) {
      const f = await fixture();
      if (learnerPlan === 'pro') await f.put(keys.plan(owner), { plan: 'pro', expiresAt: null });
      await f.put(keys.content('wrong-upstream-port', '0.1.0'), {
        ...content(), timeLimits: { free: 1200, pro },
      });
      const response = await f.handler(event(request()), context);
      assert.equal(response.statusCode, 422);
      assert.equal(bodyOf(response).code, 'VERSION_UNAVAILABLE');
      assert.equal(await f.store.active(owner), undefined);
    }
  }
});

test('receipt lookup finishes before independent admission reads start', async () => {
  const f = await fixture();
  let receiptResolved = false;
  let activeStarted = false;
  const handler = f.makeHandler({
    receipt: async (actor, requestId, abortSignal) => {
      const receipt = await f.store.receipt(actor, requestId, abortSignal);
      receiptResolved = true;
      return receipt;
    },
    snapshot: async (actor, input, abortSignal) => {
      assert.equal(receiptResolved, true);
      await sleep(0);
      assert.equal(activeStarted, true);
      return f.store.snapshot(actor, input, abortSignal);
    },
    active: async (actor, abortSignal) => {
      assert.equal(receiptResolved, true);
      activeStarted = true;
      return f.store.active(actor, abortSignal);
    },
  });
  assert.equal((await handler(event(request()), context)).statusCode, 200);
});

test('the handler preserves time to return an error when its work deadline expires', { timeout: 2000 }, async () => {
  const input = request();
  const logs: unknown[] = [];
  let receiptReads = 0;
  const fail = async (): Promise<never> => { throw new Error('Unexpected storage call'); };
  const handler = createStartHandler({
    store: {
      receipt: async (_actor, _requestId, abortSignal) => {
        receiptReads++;
        assert.ok(abortSignal);
        await sleep(10_000, undefined, { signal: abortSignal });
        return undefined;
      },
      session: fail, active: fail, snapshot: fail, commit: fail,
    },
    launchConfiguration, provision: fail,
    log: entry => logs.push(entry),
  });
  const response = await handler(event(input), {
    ...context, getRemainingTimeInMillis: () => 1050,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(bodyOf(response).requestId, input.requestId);
  assert.equal(receiptReads, 1);
  assert.equal((logs[0] as { result: string }).result, 'INTERNAL_ERROR');
});

test('the handler starts no storage work when only the response margin remains', async () => {
  let calls = 0;
  const fail = async (): Promise<never> => { calls++; throw new Error('Unexpected storage call'); };
  const handler = createStartHandler({
    store: { receipt: fail, session: fail, active: fail, snapshot: fail, commit: fail },
    launchConfiguration, provision: fail,
  });
  const response = await handler(event(request()), {
    ...context, getRemainingTimeInMillis: () => 1000,
  });
  assert.equal(response.statusCode, 500);
  assert.equal(calls, 0);
});

test('attempt labels use finalised non-error progress and enforce the wire limit', async () => {
  for (const completedAttempts of [0, 4, 1000]) {
    const f = await fixture();
    await f.put(keys.progress(owner, 'wrong-upstream-port'), { completedAttempts });
    const response = await f.handler(event(request()), context);
    if (completedAttempts === 1000) {
      assert.equal(response.statusCode, 429);
      assert.equal(await f.store.active(owner), undefined);
    } else {
      assert.equal(response.statusCode, 200);
      assert.deepEqual(bodyOf(response).session.attempt, { kind: completedAttempts ? 'retry' : 'first', number: completedAttempts + 1 });
    }
  }
});

test('concurrent copies of one request all resolve to one session', async () => {
  const f = await fixture();
  const input = request();
  const responses = await Promise.all(Array.from({ length: 16 }, () => f.handler(event(input), context)));
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  assert.equal(new Set(responses.map(response => bodyOf(response).session.id)).size, 1);
  assert.equal(responses.filter(response => !bodyOf(response).replayed).length, 1);
  assert.equal((await f.rows()).length, 4);
});

test('competing requests create one session and no losing receipts', async () => {
  const f = await fixture();
  const responses = await Promise.all(Array.from({ length: 16 }, () => f.handler(event(request()), context)));
  assert.equal(responses.filter(response => response.statusCode === 200).length, 1);
  for (const response of responses.filter(response => response.statusCode !== 200)) {
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(bodyOf(response).code, 'ACTIVE_SESSION_EXISTS');
  }
  assert.equal((await f.rows()).length, 4);
});

test('different learners can use the same request ID without sharing a session', async () => {
  const f = await fixture();
  const input = request();
  const [a, b] = await Promise.all([f.handler(event(input), context), f.handler(event(input, randomUUID()), context)]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  const firstId = bodyOf(a).session.id;
  const secondId = bodyOf(b).session.id;
  assert.notEqual(firstId, secondId);
  assert.equal((await f.store.session(firstId))?.launchArguments.clientToken, firstId);
  assert.equal((await f.store.session(secondId))?.launchArguments.clientToken, secondId);
});

test('plan, publication, and progress races cancel the whole write', async () => {
  for (const changed of ['plan', 'content', 'progress']) {
    const f = await fixture();
    await f.put(keys.plan(owner), { plan: 'pro', expiresAt: null });
    await f.put(keys.content('wrong-upstream-port', '0.1.0'), { ...content(), plan: 'pro' });
    let commits = 0;
    const handler = f.makeHandler({ commit: async admission => {
      if (++commits === 1) {
        if (changed === 'plan') await f.put(keys.plan(owner), { plan: 'free', expiresAt: null });
        if (changed === 'content') await f.put(keys.content('wrong-upstream-port', '0.1.0'), { ...content(), status: 'retired' });
        if (changed === 'progress') await f.put(keys.progress(owner, 'wrong-upstream-port'), { completedAttempts: 3 });
      }
      await f.store.commit(admission);
    } });
    const response = await handler(event(request()), context);
    assert.equal(response.statusCode, changed === 'plan' ? 403 : changed === 'content' ? 422 : 200);
    if (changed === 'progress') {
      assert.deepEqual(bodyOf(response).session.attempt, { kind: 'retry', number: 4 });
      assert.equal((await f.rows()).filter(row => row.SK === 'STATE').length, 1);
    } else assert.equal((await f.rows()).filter(row => row.SK === 'STATE').length, 0);
  }
});

test('a lost write response returns the committed session without writing again', async () => {
  const f = await fixture();
  let commits = 0;
  const handler = f.makeHandler({ commit: async admission => {
    commits++;
    await f.store.commit(admission);
    throw new Error('secret simulated connection loss');
  } });
  const input = request();
  const response = await handler(event(input), context);
  assert.equal(response.statusCode, 200);
  assert.equal(bodyOf(response).replayed, true);
  assert.equal(commits, 1);
  assert.equal((await f.rows()).length, 4);
  assert.equal(JSON.stringify(f.logs).includes('secret'), false);
});

test('a failed write leaves no partial state and can be retried', async () => {
  const f = await fixture();
  const input = request();
  const handler = f.makeHandler({ commit: async () => { throw new Error('secret storage outage'); } });
  const response = await handler(event(input), context);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('secret'), false);
  assert.equal((await f.rows()).length, 1);
  assert.equal((await f.handler(event(input), context)).statusCode, 200);
});

test('contention retries are bounded and permanent transaction errors are not retried', async () => {
  for (const code of ['ConditionalCheckFailed', 'ValidationError']) {
    const f = await fixture();
    let commits = 0;
    const handler = f.makeHandler({ commit: async () => {
      commits++;
      throw Object.assign(new Error('private error details'), {
        name: 'TransactionCanceledException', CancellationReasons: [{ Code: code }],
      });
    } });
    const response = await handler(event(request()), context);
    assert.equal(response.statusCode, 500);
    assert.equal(commits, code === 'ConditionalCheckFailed' ? 3 : 1);
    assert.equal(response.body.includes('private'), false);
    assert.equal((await f.rows()).length, 1);
  }
});

test('a lost response followed by a failed receipt read is recoverable on the next invocation', async () => {
  const f = await fixture();
  let writeCompleted = false;
  const handler = f.makeHandler({
    receipt: async (actor, requestId) => {
      if (writeCompleted) throw new Error('Receipt read failed');
      return f.store.receipt(actor, requestId);
    },
    commit: async admission => {
      await f.store.commit(admission);
      writeCompleted = true;
      throw new Error('Response lost');
    },
  });
  const input = request();
  assert.equal((await handler(event(input), context)).statusCode, 500);
  const response = await f.handler(event(input), context);
  assert.equal(response.statusCode, 200);
  assert.equal(bodyOf(response).replayed, true);
  assert.equal((await f.rows()).length, 4);
});

test('receipts cannot expose a different owner session', async () => {
  const f = await fixture();
  const input = request();
  const initial = bodyOf(await f.handler(event(input), context));
  const saved = await f.get(keys.session(initial.session.id)) as SessionRecord;
  await f.put(keys.session(initial.session.id), { ...saved, ownerId: randomUUID(), secret: 'hidden' });
  const response = await f.handler(event(input), context);
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.includes('hidden'), false);
});

test('replay returns the current saved outcome, not a stale provisioning response', async () => {
  const f = await fixture();
  const input = request();
  const initial = bodyOf(await f.handler(event(input), context));
  const saved = await f.get(keys.session(initial.session.id)) as SessionRecord;
  saved.view.status = 'error';
  saved.view.statusReason = 'start_failed';
  saved.view.endedAt = '2026-10-05T02:03:00Z';
  const privateSecret = 'z'.repeat(43);
  saved.monitorSecret = privateSecret;
  await f.put(keys.session(initial.session.id), saved);
  await f.remove(keys.active(owner));
  const response = await f.handler(event(input), context);
  assert.equal(bodyOf(response).session.status, 'error');
  assert.equal(bodyOf(response).replayed, true);
  assert.equal(response.body.includes(privateSecret), false);
  assert.equal(await f.store.active(owner), undefined);
});

test('projection drops private nested fields and logging failures do not fail admission', async () => {
  const f = await fixture();
  const handler = createStartHandler({
    store: f.store, launchConfiguration, provision: f.defaultProvision,
    log: () => { throw new Error('logger failed'); },
  });
  const response = await handler(event(request()), context);
  assert.equal(response.statusCode, 200);
  const view = bodyOf(response).session;
  view.challenge.private = 'secret';
  view.alert.private = 'secret';
  view.dashboard[0].source = 'secret';
  view.secret = 'secret';
  assert.equal(JSON.stringify(publicView(view)).includes('secret'), false);
});

test('the bundled Lambda loads on Node 22 and rejects unauthenticated input without AWS calls', async () => {
  const names = ['SESSION_TABLE_NAME', 'ECS_CLUSTER_ARN', 'ECS_SUBNET_IDS', 'ECS_SECURITY_GROUP_IDS',
    'ECS_PLATFORM_VERSION', 'MONITOR_CONTAINER_NAME', 'MONITOR_SECRET_BUCKET_ARN', 'SCHEDULER_GROUP_NAME',
    'PROVISIONING_EXPIRY_FUNCTION_ARN', 'SCHEDULER_TARGET_ROLE_ARN'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.SESSION_TABLE_NAME = 'test-unused';
    process.env.ECS_CLUSTER_ARN = launchConfiguration.clusterArn;
    process.env.ECS_SUBNET_IDS = launchConfiguration.subnetIds.join(',');
    process.env.ECS_SECURITY_GROUP_IDS = launchConfiguration.securityGroupIds.join(',');
    process.env.ECS_PLATFORM_VERSION = launchConfiguration.platformVersion;
    process.env.MONITOR_CONTAINER_NAME = launchConfiguration.monitorContainerName;
    process.env.MONITOR_SECRET_BUCKET_ARN = launchConfiguration.secretBucketArn;
    process.env.SCHEDULER_GROUP_NAME = 'test-sessions';
    process.env.PROVISIONING_EXPIRY_FUNCTION_ARN = 'arn:aws:lambda:ap-southeast-1:123456789012:function:test-expiry';
    process.env.SCHEDULER_TARGET_ROLE_ARN = 'arn:aws:iam::123456789012:role/test-scheduler';
    const bundled = createRequire(import.meta.url)('../../../dist/start-session/index.cjs');
    const response = await bundled.handler(event(request(), null), context);
    assert.equal(response.statusCode, 401);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('a stalled database request is aborted by the production transport', { timeout: 10_000 }, async () => {
  const server = createServer(() => { /* Accept the request without sending a response. */ });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new DynamoDBClient({
    region: 'us-east-1', endpoint: `http://127.0.0.1:${address.port}`, maxAttempts: 1,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    requestHandler: createAwsTransport(2000),
  });
  try {
    const store = new StartStore(DynamoDBDocumentClient.from(client), 'unused');
    const started = Date.now();
    await assert.rejects(store.receipt(owner, randomUUID(), AbortSignal.timeout(50)), { name: 'AbortError' });
    assert.ok(Date.now() - started < 1000, 'Abort signal did not preserve the response margin');
    await assert.rejects(store.receipt(owner, randomUUID()), { name: 'TimeoutError' });
  } finally {
    client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const kind of ['capacity', 'configuration'] as const) {
  test(`a confirmed ${kind} rejection replays the same failure and permits a new request`, async () => {
    const f = await fixture();
    let reject = true;
    let launches = 0;
    const provision = createProvisionSession({
      store: new LifecycleStore(database.document, f.table),
      schedule: { ensure: async () => {} }, secret: { ensure: async () => {} },
      environment: {
        launch: async () => {
          launches++;
          if (reject) throw new LaunchRejectedError({ kind, reasons: [kind === 'capacity' ? 'RESOURCE:CPU' : 'MISSING'] });
          return 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        },
        stop: async () => {},
      },
      now: () => new Date(current),
    });
    const handler = f.makeHandler({}, provision);
    const input = request();
    const first = await handler(event(input), context);
    assert.equal(first.statusCode, kind === 'capacity' ? 503 : 500);
    assert.match(bodyOf(first).message, /new request ID/);
    assert.equal(bodyOf(first).retryAfterSeconds, kind === 'capacity' ? 30 : undefined);
    assert.equal(await f.store.active(owner), undefined);
    assert.deepEqual(await handler(event(input), context), first);
    assert.equal(launches, 1);
    assert.equal((f.logs[0] as { launchFailure: { kind: string } }).launchFailure.kind, kind);
    reject = false;
    const next = await handler(event(request()), context);
    assert.equal(next.statusCode, 200);
    assert.deepEqual(bodyOf(next).session.attempt, { kind: 'first', number: 1 });
    assert.equal(launches, 2);
  });
}

test('a published task definition outside the allowed family is rejected before admission', async () => {
  const f = await fixture();
  const invalid = content();
  invalid.pins.taskDefinitionArn = invalid.pins.taskDefinitionArn.replace('opsreplay-test', 'wrong-upstream-port');
  await f.put(keys.content(invalid.challenge.id, invalid.challenge.version), invalid);
  const response = await f.handler(event(request()), context);
  assert.equal(response.statusCode, 422);
  assert.equal(bodyOf(response).code, 'VERSION_UNAVAILABLE');
  assert.equal((await f.rows()).length, 1);
  assert.equal(f.provisions.length, 0);
});

test('start uses the provisioned record without a final read and checks its ownership', async () => {
  const f = await fixture();
  let reads = 0;
  const handler = f.makeHandler({ session: async (...args) => { reads++; return f.store.session(...args); } });
  const input = request();
  assert.equal((await handler(event(input), context)).statusCode, 200);
  assert.equal(reads, 0);
  assert.equal((await handler(event(input), context)).statusCode, 200);
  assert.equal(reads, 1); // Replay still verifies ownership before provisioning.
  const wrongOwner = f.makeHandler({}, async id => ({ ...await f.defaultProvision(id), ownerId: randomUUID() }));
  assert.equal((await wrongOwner(event(input), context)).statusCode, 404);
});
