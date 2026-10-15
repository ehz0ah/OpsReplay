import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand, DeleteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocalDatabase } from './local-dynamodb.js';
import { createListCatalogHandler } from '../src/list-catalog/handler.js';
import { createGetAccountHandler } from '../src/get-account/handler.js';
import { withPublicApiPolicy } from '../src/shared/public-api.js';
import { catalogueKey } from '../../../packages/content/src/catalogue.js';
import { projectCatalogue, prepareReferenceRelease } from '../../../packages/content/src/release.js';
import { referenceBuild, referenceIdentity, referenceTask } from '../../../packages/content/test/reference-fixture.js';
import { sessionRecord } from './session-fixture.js';
import { keys } from '../src/start-session/store.js';
const owner = sessionRecord(randomUUID()).ownerId;
const clock = Date.parse('2026-10-16T00:00:00.000Z');
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => {
  database = await startLocalDatabase();
});
after(() => database?.close());
const context = { getRemainingTimeInMillis: () => 10000 };
function event(resource: string, query: Record<string, string[]> | null = null, sub: unknown = owner) {
  return {
    httpMethod: 'GET',
    resource,
    body: null,
    isBase64Encoded: false,
    queryStringParameters: null,
    multiValueQueryStringParameters: query,
    requestContext: { authorizer: { claims: { sub, token_use: 'id', aud: 'testclient' } } },
  } as unknown as APIGatewayProxyEvent;
}
async function fixture() {
  const table = `bootstrap-${randomUUID()}`;
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
  const put = (key: object, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key, data } }));
  const read = createListCatalogHandler(database.document, table);
  const account = withPublicApiPolicy(
    createGetAccountHandler(database.document, table, () => clock),
    { allowedOrigin: 'http://localhost:3000', clientId: 'testclient' },
  );
  return { table, put, read, account };
}
const entry = projectCatalogue(
  prepareReferenceRelease(referenceBuild, referenceIdentity, referenceTask(), 1800).manifest,
);
test('catalogue reads only published projections and paginates one filter dataset', async () => {
  const f = await fixture();
  const second = { ...entry, id: 'second-challenge', plan: 'pro' as const, tier: 'medium' as const };
  await f.put(catalogueKey(entry), entry);
  await f.put(catalogueKey(second), second);
  await f.put({ PK: 'CONTENT#secret', SK: 'VERSION#0.1.0' }, { plantedFault: 'private' });
  const first = await f.read(event('/v1/catalog', { limit: ['1'] }, undefined), context);
  assert.equal(first.statusCode, 200);
  const body = JSON.parse(first.body);
  assert.equal(body.items.length, 1);
  assert.deepEqual(body.availableFilters.plans, ['free', 'pro']);
  const next = await f.read(event('/v1/catalog', { cursor: [body.nextCursor], limit: ['1'] }), context);
  assert.equal(next.statusCode, 200);
  assert.notEqual(JSON.parse(next.body).items[0].id, body.items[0].id);
  assert.equal(JSON.parse(next.body).nextCursor, null);
  assert.equal(first.body.includes('private'), false);
  assert.equal((await f.read(event('/v1/catalog', { plan: ['pro'] }), context)).statusCode, 200);
  assert.equal(
    JSON.parse((await f.read(event('/v1/catalog', { plan: ['pro'] }), context)).body).items[0].id,
    second.id,
  );
  assert.equal(
    (await f.read(event('/v1/catalog', { cursor: [body.nextCursor], plan: ['pro'] }), context)).statusCode,
    400,
  );
  await f.put(catalogueKey({ ...entry, id: 'new-challenge' }), { ...entry, id: 'new-challenge' });
  assert.equal((await f.read(event('/v1/catalog', { cursor: [body.nextCursor] }), context)).statusCode, 400);
});
test('catalogue rejects malformed parameters and invalid storage without leaking data', async () => {
  const f = await fixture();
  for (const query of [
    { limit: ['1', '2'] },
    { limit: ['1.0'] },
    { mode: ['unexpected'] },
    { unknown: ['x'] },
    { cursor: ['not base64'] },
    { category: [''] },
  ])
    assert.equal((await f.read(event('/v1/catalog', query), context)).statusCode, 400);
  await f.put(catalogueKey(entry), { ...entry, plantedFault: 'secret' });
  const result = await f.read(event('/v1/catalog'), context);
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.includes('secret'), false);
});
test('catalogue query follows storage pages and rejects nonadvancing continuation', async () => {
  let calls = 0;
  const client = {
    send: async (command: QueryCommand) => {
      assert.ok(command instanceof QueryCommand);
      assert.equal(command.input.ConsistentRead, true);
      assert.equal(command.input.ExpressionAttributeValues?.[':pk'], 'CATALOG#PUBLIC');
      calls++;
      return calls === 1
        ? { Items: [], LastEvaluatedKey: { PK: 'CATALOG#PUBLIC', SK: 'ENTRY#challenge#before#0.1.0' } }
        : { Items: [{ ...catalogueKey(entry), data: entry }] };
    },
  } as unknown as DynamoDBDocumentClient;
  const result = await createListCatalogHandler(client, 'test-table')(event('/v1/catalog'), context);
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(JSON.parse(result.body).items.length, 1);
  const stuck = {
    send: async () => ({ Items: [], LastEvaluatedKey: { PK: 'CATALOG#PUBLIC', SK: 'ENTRY#challenge#before#0.1.0' } }),
  } as unknown as DynamoDBDocumentClient;
  assert.equal((await createListCatalogHandler(stuck, 'test-table')(event('/v1/catalog'), context)).statusCode, 500);
});
test('account uses the same effective grant and exact expiry boundary as session start', async () => {
  const f = await fixture();
  assert.deepEqual(JSON.parse((await f.account(event('/v1/me'), context)).body), {
    plan: 'free',
    planSource: 'default',
    planExpiresAt: null,
    activeSessionId: null,
  });
  for (const expiresAt of [
    null,
    new Date(clock + 1).toISOString(),
    new Date(clock).toISOString(),
    new Date(clock - 1).toISOString(),
  ]) {
    await f.put(keys.plan(owner), { plan: 'pro', expiresAt });
    const result = JSON.parse((await f.account(event('/v1/me'), context)).body);
    const valid = expiresAt === null || Date.parse(expiresAt) > clock;
    assert.equal(result.plan, valid ? 'pro' : 'free');
    assert.equal(result.planSource, valid ? 'grant' : 'default');
    assert.equal(result.planExpiresAt, valid ? expiresAt : null);
  }
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: 'secret' });
  const invalid = await f.account(event('/v1/me'), context);
  assert.equal(invalid.statusCode, 500);
  assert.equal(invalid.body.includes('secret'), false);
});
test('account resumes only its owned lock and does not change or clean up session state', async () => {
  const f = await fixture();
  const id = randomUUID();
  await f.put(keys.session(id), sessionRecord(id));
  await f.put(keys.active(owner), { sessionId: id, requestId: randomUUID() });
  assert.equal(JSON.parse((await f.account(event('/v1/me'), context)).body).activeSessionId, id);
  await f.put(keys.session(id), { ...sessionRecord(id), ownerId: 'different-owner' });
  const result = await f.account(event('/v1/me'), context);
  assert.equal(result.statusCode, 500);
  assert.equal(result.body.includes(id), false);
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: keys.active(owner) }));
  assert.equal(JSON.parse((await f.account(event('/v1/me'), context)).body).activeSessionId, null);
});
test('missing identity, wrong client, malformed request and expired budgets cannot read account data', async () => {
  let reads = 0;
  const client = {
    send: async () => {
      reads++;
      throw new Error('unexpected read');
    },
  } as unknown as DynamoDBDocumentClient;
  const handler = withPublicApiPolicy(createGetAccountHandler(client, 'test-table'), {
    allowedOrigin: 'https://app.example',
    clientId: 'testclient',
  });
  const missing = event('/v1/me', null, null);
  assert.equal((await handler(missing, context)).statusCode, 401);
  const wrong = event('/v1/me');
  wrong.requestContext.authorizer!.claims.aud = 'other';
  assert.equal((await handler(wrong, context)).statusCode, 401);
  assert.equal((await handler(event('/v1/me', { owner: ['other'] }), context)).statusCode, 400);
  assert.equal((await handler(event('/v1/me'), { getRemainingTimeInMillis: () => 1 })).statusCode, 500);
  assert.equal(reads, 0);
});
