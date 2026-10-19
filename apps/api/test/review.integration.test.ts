import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { startLocalDatabase } from './local-dynamodb.js';
import { ReviewStore } from '../src/reviews/store.js';
import { createGetReviewHandler } from '../src/get-review/handler.js';
import { createSubmitReviewHandler } from '../src/submit-review/handler.js';
import { publishReview } from '../../../packages/content/src/review-publish.js';
import { reviewKeys, type ReviewBundle } from '../../../packages/content/src/review.js';
import { keys } from '../src/start-session/store.js';
import { withPublicApiPolicy } from '../src/shared/public-api.js';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => {
  database = await startLocalDatabase();
});
after(() => database?.close());
const owner = randomUUID(),
  other = randomUUID(),
  now = Date.parse('2026-10-20T00:00:00.000Z');
const bundle = JSON.parse(
  readFileSync(new URL('../../../content/reviews/proxy-rollout/review.json', import.meta.url), 'utf8'),
) as ReviewBundle;
const context = { getRemainingTimeInMillis: () => 10000 };
function event(method = 'GET', body?: unknown, sub: unknown = owner) {
  return {
    httpMethod: method,
    resource: method === 'GET' ? '/v1/reviews/{id}' : '/v1/reviews/{id}/submissions',
    pathParameters: { id: bundle.id },
    body: body === undefined ? null : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { claims: { sub, token_use: 'id', aud: 'testclient' } } },
  } as unknown as APIGatewayProxyEvent;
}
const request = () => ({
  requestId: randomUUID(),
  exerciseVersion: bundle.version,
  flags: [{ file: 'deploy.sh', side: 'new', line: 4, concern: 'The restart can stop nginx with invalid config.' }],
});
async function fixture(plan: 'free' | 'pro' = 'free') {
  const table = 'review-' + randomUUID();
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
  await publishReview(database.document, table, { ...bundle, plan }, AbortSignal.timeout(10000));
  const store = new ReviewStore(database.document, table, () => now);
  const policy = { clientId: 'testclient', allowedOrigin: 'http://localhost:3000' };
  return {
    table,
    store,
    read: withPublicApiPolicy(createGetReviewHandler(store), policy),
    submit: withPublicApiPolicy(createSubmitReviewHandler(store), policy),
    put: (Key: object, data: unknown) =>
      database.document.send(new PutCommand({ TableName: table, Item: { ...Key, data } })),
  };
}
test('pre-submission exercise hides all findings; committed submission releases deterministic explanations', async () => {
  const f = await fixture();
  const read = await f.read(event(), context);
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.includes('missing-config-validation'), false);
  assert.equal(read.body.includes('findings'), false);
  const submitted = await f.submit(event('POST', request()), context);
  assert.equal(submitted.statusCode, 200);
  const result = JSON.parse(submitted.body);
  assert.deepEqual(result.summary, { found: 2, missed: 0 });
  assert.equal(result.answerInformed, false);
  assert.equal(result.findings.length, 2);
  assert.deepEqual((await f.store.owned(result.id, owner, AbortSignal.timeout(10000))).view, result);
  await assert.rejects(f.store.owned(result.id, other, AbortSignal.timeout(10000)), /NOT_FOUND/);
});
test('same request recovers after content withdrawal and plan expiry without a second submission', async () => {
  const f = await fixture('pro');
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: new Date(now + 1).toISOString() });
  const body = request(),
    first = await f.submit(event('POST', body), context);
  assert.equal(first.statusCode, 200);
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: new Date(now).toISOString() });
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: reviewKeys.published(bundle.id) }));
  const replay = await f.submit(event('POST', body), context);
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(replay.body).id, JSON.parse(first.body).id);
  assert.equal(JSON.parse(replay.body).replayed, true);
  const changed = await f.submit(event('POST', { ...body, flags: [] }), context);
  assert.equal(changed.statusCode, 409);
});
test('concurrent duplicate requests commit once; distinct submissions label exactly one as uninformed', async () => {
  const f = await fixture(),
    body = request();
  const copies = await Promise.all([f.submit(event('POST', body), context), f.submit(event('POST', body), context)]);
  assert.ok(copies.every((copy) => copy.statusCode === 200));
  assert.equal(JSON.parse(copies[0]!.body).id, JSON.parse(copies[1]!.body).id);
  const records = await database.document.send(
    new QueryCommand({
      TableName: f.table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': 'USER#' + owner, ':prefix': 'REVIEWREQ#' },
      ConsistentRead: true,
    }),
  );
  assert.equal(records.Count, 1);
  const g = await fixture();
  const distinct = await Promise.all([
    g.submit(event('POST', request()), context),
    g.submit(event('POST', request()), context),
  ]);
  assert.ok(distinct.every((copy) => copy.statusCode === 200));
  assert.deepEqual(distinct.map((copy) => JSON.parse(copy.body).answerInformed).sort(), [false, true]);
});
test('invalid flag, version, identity and Pro access are rejected before saving findings', async () => {
  const f = await fixture(),
    body = request();
  assert.equal(
    (await f.submit(event('POST', { ...body, flags: [{ ...body.flags[0], line: 900 }] }), context)).statusCode,
    400,
  );
  assert.equal((await f.submit(event('POST', { ...body, exerciseVersion: '9.0.0' }), context)).statusCode, 422);
  assert.equal((await f.read(event('GET', undefined, null), context)).statusCode, 401);
  const p = await fixture('pro');
  assert.equal((await p.read(event(), context)).statusCode, 403);
  assert.equal((await p.submit(event('POST', body), context)).statusCode, 403);
  const wrong = event();
  wrong.requestContext.authorizer!.claims.aud = 'other';
  assert.equal((await f.read(wrong, context)).statusCode, 401);
});
test('uncertain transaction response recovers its receipt and does not repeat the effect', async () => {
  const f = await fixture();
  let writes = 0;
  const client = {
    send: async (command: any, options: any) => {
      const value = await database.document.send(command, options);
      if (command instanceof TransactWriteCommand && ++writes === 1) throw new Error('response lost');
      return value;
    },
  } as unknown as DynamoDBDocumentClient;
  const handler = createSubmitReviewHandler(new ReviewStore(client, f.table, () => now));
  const result = await handler(event('POST', request()), context);
  assert.equal(result.statusCode, 200);
  assert.equal(writes, 1);
});
