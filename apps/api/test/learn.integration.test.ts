import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { startLocalDatabase } from './local-dynamodb.js';
import { createGetLearnHandler } from '../src/get-learn/handler.js';
import { parseLesson, prepareLesson, learnKey } from '../../../packages/content/src/learn.js';
import { publishLesson } from '../../../packages/content/src/learn-publish.js';
import { keys } from '../src/start-session/store.js';
import { withPublicApiPolicy } from '../src/shared/public-api.js';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => {
  database = await startLocalDatabase();
});
after(() => database?.close());
const owner = randomUUID(),
  now = Date.parse('2026-10-20T00:00:00.000Z');
const entry = parseLesson(
  readFileSync(new URL('../../../content/learn/safe-incident-recovery.md', import.meta.url), 'utf8'),
  new Set(['challenge#wrong-upstream-port']),
);
function event(id = entry.id, sub: unknown = owner) {
  return {
    httpMethod: 'GET',
    resource: '/v1/learn/{id}',
    pathParameters: { id },
    body: null,
    isBase64Encoded: false,
    requestContext: { authorizer: { claims: { sub, token_use: 'id', aud: 'testclient' } } },
  } as unknown as APIGatewayProxyEvent;
}
const context = { getRemainingTimeInMillis: () => 10000 };
async function fixture(plan: 'free' | 'pro' = 'free') {
  const table = 'learn-' + randomUUID();
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
  const lesson = { ...entry, plan },
    prepared = prepareLesson(lesson);
  const objects = new Map<string, string>();
  let reads = 0;
  const s3 = {
    send: async (command: GetObjectCommand | PutObjectCommand) => {
      if (command instanceof PutObjectCommand) {
        assert.equal(command.input.IfNoneMatch, '*');
        objects.set(command.input.Key!, String(command.input.Body));
        return {};
      }
      assert.ok(command instanceof GetObjectCommand);
      reads++;
      const body = objects.get(command.input.Key!);
      if (!body) throw new Error('missing');
      return { Body: Readable.from([Buffer.from(body)]), ContentLength: Buffer.byteLength(body) };
    },
  } as unknown as S3Client;
  const handler = withPublicApiPolicy(
    createGetLearnHandler(database.document, table, s3, 'test-recordings', () => now),
    { clientId: 'testclient', allowedOrigin: 'http://localhost:3000' },
  );
  return {
    table,
    lesson,
    prepared,
    objects,
    s3,
    handler,
    reads: () => reads,
    publish: () => publishLesson(database.document, table, s3, 'test-recordings', lesson, AbortSignal.timeout(10000)),
    put: (Key: object, data: unknown) =>
      database.document.send(new PutCommand({ TableName: table, Item: { ...Key, data } })),
  };
}
test('publication creates immutable source and catalogue atomically and identical retry works', async () => {
  const f = await fixture();
  await f.publish();
  await f.publish();
  const result = await f.handler(event(entry.id, null), context);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), entry);
  assert.equal(result.headers?.['Access-Control-Allow-Origin'], 'http://localhost:3000');
  await assert.rejects(
    publishLesson(
      database.document,
      f.table,
      f.s3,
      'test-recordings',
      { ...entry, title: 'changed' },
      AbortSignal.timeout(10000),
    ),
    /already published/,
  );
});
test('Pro read checks verified identity and exact plan expiry before any object read', async () => {
  const f = await fixture('pro');
  await f.publish();
  assert.equal((await f.handler(event(entry.id, null), context)).statusCode, 401);
  assert.equal((await f.handler(event(), context)).statusCode, 403);
  assert.equal(f.reads(), 1); // The publication integrity read precedes learner reads.
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: new Date(now).toISOString() });
  assert.equal((await f.handler(event(), context)).statusCode, 403);
  await f.put(keys.plan(owner), { plan: 'pro', expiresAt: new Date(now + 1).toISOString() });
  assert.equal((await f.handler(event(), context)).statusCode, 200);
  const wrong = event();
  wrong.requestContext.authorizer!.claims.aud = 'other';
  assert.equal((await f.handler(wrong, context)).statusCode, 401);
});
test('failed upload does not publish content; corrupt source and private references fail closed', async () => {
  const f = await fixture();
  await assert.rejects(
    publishLesson(
      database.document,
      f.table,
      {
        send: async () => {
          throw new Error('offline');
        },
      } as unknown as S3Client,
      'test-recordings',
      entry,
      AbortSignal.timeout(10000),
    ),
  );
  assert.equal(
    (await database.document.send(new GetCommand({ TableName: f.table, Key: learnKey(entry.id) }))).Item,
    undefined,
  );
  await f.publish();
  f.objects.set(f.prepared.release.objectKey, 'private corrupt text');
  const response = await f.handler(event(), context);
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.includes('private'), false);
  await f.put(learnKey(entry.id), { ...f.prepared.release, objectKey: 'sessions/secret' });
  assert.equal((await f.handler(event(), context)).statusCode, 500);
});
test('malformed requests, missing content and expired invocation budget are explicit', async () => {
  const f = await fixture();
  assert.equal((await f.handler(event('unknown'), context)).statusCode, 404);
  assert.equal((await f.handler(event('../secret'), context)).statusCode, 400);
  assert.equal((await f.handler({ ...event(), body: '{}' }, context)).statusCode, 400);
  assert.equal((await f.handler(event(), { getRemainingTimeInMillis: () => 1 })).statusCode, 500);
});
