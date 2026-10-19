import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { startLocalDatabase } from './local-dynamodb.js';
import { sessionRecord } from './session-fixture.js';
import { keys } from '../src/start-session/store.js';
import { backfillHistory } from '../src/history/backfill.js';
import { historyKey } from '../../../packages/session/src/history.js';
import { HistoryReader } from '../src/history/reader.js';
import { createListSessionsHandler } from '../src/list-sessions/handler.js';
import { createListReviewSubmissionsHandler } from '../src/list-review-submissions/handler.js';
import { createGetReviewSubmissionHandler } from '../src/get-review-submission/handler.js';
import { ReviewStore } from '../src/reviews/store.js';
import { publishReview } from '../../../packages/content/src/review-publish.js';
import { readFileSync } from 'node:fs';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => {
  database = await startLocalDatabase();
});
after(() => database?.close());
const owner = sessionRecord(randomUUID()).ownerId,
  other = randomUUID();
function event(resource = '/v1/sessions', query: Record<string, string[]> | null = null, sub: unknown = owner) {
  return {
    httpMethod: 'GET',
    resource,
    body: null,
    isBase64Encoded: false,
    multiValueQueryStringParameters: query,
    requestContext: { authorizer: { claims: { sub } } },
  } as unknown as APIGatewayProxyEvent;
}
const context = { getRemainingTimeInMillis: () => 10000 };
async function fixture() {
  const table = 'history-' + randomUUID();
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
  const reader = new HistoryReader(database.document, table);
  const put = (Key: object, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...Key, data } }));
  const seed = async (at: string) => {
    const saved = sessionRecord(randomUUID());
    saved.view.createdAt = at;
    saved.accessGrant.admittedAt = at;
    saved.provisioningDeadline = new Date(Date.parse(at) + 180000).toISOString();
    saved.launchRecoveryDeadline = new Date(Date.parse(at) + 480000).toISOString();
    await put(keys.session(saved.view.id), saved);
    await put(historyKey(owner, 'session', at, saved.view.id), { schemaVersion: 1, id: saved.view.id, at });
    return saved;
  };
  return {
    table,
    put,
    seed,
    sessions: createListSessionsHandler(reader),
    reviews: createListReviewSubmissionsHandler(reader),
  };
}
test('session history preserves a first-page upper bound and reads authoritative changed status', async () => {
  const f = await fixture(),
    older = await f.seed('2026-10-20T00:00:00.000Z'),
    latest = await f.seed('2026-10-20T00:00:01.000Z');
  const first = await f.sessions(event('/v1/sessions', { limit: ['1'] }), context);
  assert.equal(first.statusCode, 200);
  const page = JSON.parse(first.body);
  assert.equal(page.items[0].id, latest.view.id);
  assert.ok(page.nextCursor);
  await f.seed('2026-10-20T00:00:02.000Z');
  const next = await f.sessions(event('/v1/sessions', { limit: ['1'], cursor: [page.nextCursor] }), context);
  assert.equal(next.statusCode, 200);
  assert.equal(JSON.parse(next.body).items[0].id, older.view.id);
  assert.equal(
    (await f.sessions(event('/v1/sessions', { cursor: [page.nextCursor] }, other), context)).statusCode,
    400,
  );
  older.view.status = 'ended';
  older.view.endedAt = '2026-10-20T00:01:00.000Z';
  older.view.statusReason = 'learner_ended';
  await f.put(keys.session(older.view.id), older);
  const updated = await f.sessions(event('/v1/sessions', { cursor: [page.nextCursor] }), context);
  assert.equal(JSON.parse(updated.body).items[0].status, 'ended');
});
test('history never trusts an owner reference pointing to another learner and rejects malformed pages', async () => {
  const f = await fixture(),
    saved = await f.seed('2026-10-20T00:00:00.000Z');
  saved.ownerId = other;
  await f.put(keys.session(saved.view.id), saved);
  const leaked = await f.sessions(event(), context);
  assert.equal(leaked.statusCode, 500);
  assert.equal(leaked.body.includes(saved.view.id), false);
  for (const query of [
    { limit: ['0'] },
    { limit: ['101'] },
    { limit: ['1', '2'] },
    { cursor: ['bad cursor'] },
    { owner: [other] },
  ])
    assert.equal((await f.sessions(event('/v1/sessions', query), context)).statusCode, 400);
  assert.equal((await f.sessions(event('/v1/sessions', null, null), context)).statusCode, 401);
});
test('review submission and its history commit together and owned results survive plan expiry', async () => {
  const f = await fixture(),
    bundle = JSON.parse(
      readFileSync(new URL('../../../content/reviews/proxy-rollout/review.json', import.meta.url), 'utf8'),
    );
  await publishReview(database.document, f.table, bundle, AbortSignal.timeout(10000));
  const store = new ReviewStore(database.document, f.table, () => Date.parse('2026-10-20T00:00:00.000Z'));
  const result = await store.submit(
    bundle.id,
    { requestId: randomUUID(), exerciseVersion: bundle.version, flags: [] },
    owner,
    AbortSignal.timeout(10000),
  );
  const listed = await f.reviews(event('/v1/review-submissions'), context);
  assert.equal(listed.statusCode, 200);
  assert.equal(JSON.parse(listed.body).items[0].id, result.id);
  const get = createGetReviewSubmissionHandler(store),
    request = { ...event('/v1/review-submissions/{id}'), pathParameters: { id: result.id } };
  assert.equal((await get(request, context)).statusCode, 200);
  assert.equal(
    (await get({ ...request, requestContext: event('/v1/review-submissions', null, other).requestContext }, context))
      .statusCode,
    404,
  );
});

test('explicit migration backfills owned prior receipts idempotently without changing session state', async () => {
  const f = await fixture(),
    saved = sessionRecord(randomUUID());
  await f.put(keys.session(saved.view.id), saved);
  await f.put(keys.receipt(owner, randomUUID()), { sessionId: saved.view.id });
  assert.equal(await backfillHistory(database.document, f.table, owner, AbortSignal.timeout(10000)), 1);
  assert.equal(await backfillHistory(database.document, f.table, owner, AbortSignal.timeout(10000)), 1);
  const response = await f.sessions(event(), context);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).items.length, 1);
  saved.ownerId = other;
  await f.put(keys.session(saved.view.id), saved);
  await assert.rejects(
    backfillHistory(database.document, f.table, owner, AbortSignal.timeout(10000)),
    /ownership mismatch/,
  );
});
