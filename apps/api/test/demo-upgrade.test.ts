import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  GetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DemoUpgradeStore, DemoUpgradeUnavailable } from '../src/demo-upgrade/store.js';
import { createDemoUpgradeHandler } from '../src/demo-upgrade/handler.js';
import { demoUpgradeDeadline, demoPolicyFromEnvironment, loadDemoUpgradePolicy } from '../src/demo-upgrade/policy.js';
import { createGetAccountHandler } from '../src/get-account/handler.js';
import { withPublicApiPolicy } from '../src/shared/public-api.js';
import { parsePublic } from '../../../packages/contracts/public-validation.js';

const now = Date.parse('2026-10-26T00:00:00.000Z');
const expiresAt = '2026-10-26T02:00:00.000Z';
const policy = { expiresAt, owners: new Set(['learner']) };
const requestId = '22222222-2222-4222-8222-222222222222';
const context = { getRemainingTimeInMillis: () => 10000 };
const event = (extra: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    httpMethod: 'POST',
    resource: '/v1/demo-upgrade',
    body: JSON.stringify({ requestId }),
    isBase64Encoded: false,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    requestContext: { authorizer: { claims: { sub: 'learner', token_use: 'id', aud: 'client' } } },
    ...extra,
  }) as APIGatewayProxyEvent;

test('demo upgrade is default-off and requires an exact bounded allowlist and canonical UTC deadline', () => {
  assert.equal(loadDemoUpgradePolicy({}), undefined);
  assert.equal(loadDemoUpgradePolicy({ DEMO_UPGRADE_ENABLED: 'false' }), undefined);
  const env = {
    DEMO_UPGRADE_ENABLED: 'true',
    DEMO_UPGRADE_OWNERS: 'learner,another',
    DEMO_UPGRADE_EXPIRES_AT: expiresAt,
  };
  assert.deepEqual(loadDemoUpgradePolicy(env), { expiresAt, owners: new Set(['learner', 'another']) });
  for (const update of [
    { DEMO_UPGRADE_ENABLED: 'TRUE' },
    { DEMO_UPGRADE_OWNERS: '' },
    { DEMO_UPGRADE_OWNERS: 'learner,learner' },
    { DEMO_UPGRADE_OWNERS: 'learner, another' },
    { DEMO_UPGRADE_EXPIRES_AT: 'not-a-date' },
    { DEMO_UPGRADE_EXPIRES_AT: '2026-10-26T02:00:00+00:00' },
    { DEMO_UPGRADE_OWNERS: Array.from({ length: 21 }, (_, i) => `learner${i}`).join(',') },
  ])
    assert.throws(() => loadDemoUpgradePolicy({ ...env, ...update }));
  assert.equal(demoUpgradeDeadline(policy, 'learner', now), expiresAt);
  assert.equal(demoUpgradeDeadline(policy, 'another', now), null);
  assert.equal(demoUpgradeDeadline(policy, 'learner', Date.parse(expiresAt)), null);
  assert.throws(() => demoUpgradeDeadline(policy, 'learner', NaN));
});

test('demo mutation takes only a validated request identity and never trusts client plan or owner', async () => {
  let calls = 0;
  const store = {
    activate: async () => {
      calls++;
      return { changed: true, expiresAt };
    },
  };
  const handler = createDemoUpgradeHandler(store, policy, () => now);
  for (const input of [
    event({ httpMethod: 'GET' }),
    event({ resource: '/v1/other' }),
    event({ isBase64Encoded: true }),
    event({ body: null }),
    event({ body: '{' }),
    event({ body: 'null' }),
    event({ body: 'x'.repeat(257) }),
    event({ body: JSON.stringify({ requestId, plan: 'pro' }) }),
    event({ body: JSON.stringify({ requestId, owner: 'another' }) }),
    event({ body: JSON.stringify({ requestId: 'wrong' }) }),
    event({ queryStringParameters: { owner: 'another' } }),
    event({ multiValueQueryStringParameters: { owner: ['another'] } }),
  ]) {
    const result = await handler(input, context);
    assert.equal(result.statusCode, 400);
    await parsePublic('Error', JSON.parse(result.body));
  }
  assert.equal(calls, 0);
  const success = await handler(event(), context);
  assert.equal(success.statusCode, 200);
  assert.deepEqual(await parsePublic('DemoUpgradeResult', JSON.parse(success.body)), { changed: true, expiresAt });
  assert.equal(calls, 1);
});

test('disabled, expired, unapproved and wrong-audience requests stop before effects', async () => {
  let calls = 0;
  const store = {
    activate: async () => {
      calls++;
      return { changed: true, expiresAt };
    },
  };
  for (const selected of [
    undefined,
    { ...policy, owners: new Set(['another']) },
    { ...policy, expiresAt: new Date(now).toISOString() },
  ])
    assert.equal((await createDemoUpgradeHandler(store, selected, () => now)(event(), context)).statusCode, 403);
  const handler = withPublicApiPolicy(
    createDemoUpgradeHandler(store, policy, () => now),
    { allowedOrigin: 'https://example.org', clientId: 'client' },
  );
  for (const claims of [
    { sub: 'learner', token_use: 'access', aud: 'client' },
    { sub: 'learner', token_use: 'id', aud: 'foreign' },
    {},
  ]) {
    const response = await handler(
      event({ requestContext: { ...event().requestContext, authorizer: { claims } } }),
      context,
    );
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers?.['Access-Control-Allow-Origin'], 'https://example.org');
    assert.equal(response.body.includes('foreign'), false);
  }
  assert.equal(calls, 0);
});

test('exhausted runtime, unknown store errors and failed logging never report activation', async () => {
  let calls = 0;
  const store = {
    activate: async () => {
      calls++;
      throw new Error('private storage detail');
    },
  };
  const handler = createDemoUpgradeHandler(
    store,
    policy,
    () => now,
    () => {
      throw new Error('log failure');
    },
  );
  const timeout = await handler(event(), { getRemainingTimeInMillis: () => 500 });
  assert.equal(timeout.statusCode, 500);
  assert.equal(calls, 0);
  const failed = await handler(event(), context);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.body.includes('private'), false);
  assert.equal(failed.body.includes('log failure'), false);
  assert.equal(JSON.parse(failed.body).requestId, requestId);
});

test('account display exposes only the matching demo deadline and uses server plan truth', async () => {
  const client = {
    send: async (command: TransactGetCommand) => {
      assert.ok(command instanceof TransactGetCommand);
      return { Responses: [{}, {}] };
    },
  } as unknown as DynamoDBDocumentClient;
  const input = event({ httpMethod: 'GET', resource: '/v1/me', body: null });
  for (const selected of [
    policy,
    { ...policy, owners: new Set(['another']) },
    { ...policy, expiresAt: new Date(now).toISOString() },
  ]) {
    const response = await createGetAccountHandler(client, 'table', () => now, undefined, selected)(input, context);
    const account = await parsePublic('Account', JSON.parse(response.body));
    assert.equal(account.plan, 'free');
    assert.equal(account.demoUpgradeExpiresAt, selected === policy ? expiresAt : null);
    assert.equal(response.body.includes('another'), false);
  }
});

test('invalid optional demo configuration disables activation without breaking normal account access', async () => {
  const logs: object[] = [];
  const selected = demoPolicyFromEnvironment(
    { DEMO_UPGRADE_ENABLED: 'true', DEMO_UPGRADE_OWNERS: 'private invalid' },
    (value) => logs.push(value),
  );
  assert.equal(selected, undefined);
  assert.deepEqual(logs, [{ operation: 'load_demo_upgrade', result: 'INVALID_CONFIG' }]);
  const client = {
    send: async () => ({ Responses: [{ Item: { data: { plan: 'pro', expiresAt: null } } }, {}] }),
  } as unknown as DynamoDBDocumentClient;
  const account = await createGetAccountHandler(
    client,
    'table',
    () => now,
    undefined,
    selected,
  )(event({ httpMethod: 'GET', resource: '/v1/me', body: null }), context);
  assert.equal(account.statusCode, 200);
  assert.equal(JSON.parse(account.body).plan, 'pro');
  assert.equal(JSON.parse(account.body).demoUpgradeExpiresAt, undefined);
  const upgrade = await createDemoUpgradeHandler(
    {
      activate: async () => {
        throw new Error('Must not run');
      },
    },
    selected,
    () => now,
  )(event(), context);
  assert.equal(upgrade.statusCode, 403);
  assert.equal(
    demoPolicyFromEnvironment({ DEMO_UPGRADE_ENABLED: 'INVALID' }, () => {
      throw new Error('Logging failed');
    }),
    undefined,
  );
});

test('transaction conflicts reuse the exact request and contention or unknown errors stay bounded', async () => {
  for (const failure of ['transaction', 'condition', 'unknown'] as const) {
    let writes = 0;
    let first: TransactWriteCommand | undefined;
    const client = {
      send: async (command: GetCommand | TransactWriteCommand) => {
        if (command instanceof GetCommand) return {};
        writes++;
        first ??= command;
        if (failure === 'transaction') {
          assert.equal(command, first);
          throw Object.assign(new Error('conflict'), { name: 'TransactionConflictException' });
        }
        if (failure === 'condition')
          throw Object.assign(new Error('condition'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
          });
        throw new Error('unavailable');
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(
      new DemoUpgradeStore(client, 'table').activate(
        'learner',
        requestId,
        expiresAt,
        () => now,
        AbortSignal.timeout(10000),
      ),
    );
    assert.equal(writes, failure === 'unknown' ? 1 : 4);
  }
});

test('a presentation window that closes during storage reads returns access denied, not a false idempotency conflict', async () => {
  const response = await createDemoUpgradeHandler(
    {
      activate: async () => {
        throw new DemoUpgradeUnavailable();
      },
    },
    policy,
    () => now,
  )(event(), context);
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).code, 'ACCESS_DENIED');
});
