import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createEndSessionHandler } from '../src/end-session/handler.js';
import { AttemptStoreError } from '../../../packages/session/src/attempt-store.js';
import { sessionRecord } from './session-fixture.js';
const id = randomUUID();
const requestId = randomUUID();
const context = { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 5000 };
const event = (body: unknown = { requestId }, owner: unknown = 'learner-1') =>
  ({
    httpMethod: 'POST',
    resource: '/v1/sessions/{id}/end',
    pathParameters: { id },
    requestContext: { authorizer: { claims: { sub: owner } } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEvent;
test('end handler authorises the owner, forwards the request receipt, and exposes only the public session', async () => {
  const record = sessionRecord(id);
  record.ownerId = 'learner-1';
  record.view.status = 'ended';
  record.view.statusReason = 'learner_ended';
  record.view.endedAt = '2026-10-10T08:00:00.000Z';
  const calls: unknown[][] = [];
  const handler = createEndSessionHandler({
    store: {
      outcome: async (...args) => {
        calls.push(args);
        return record;
      },
    },
    now: () => new Date(record.view.endedAt!),
  });
  const response = await handler(event(), context);
  assert.equal(response.statusCode, 200);
  assert.equal(calls[0]?.[5], 'learner-1');
  assert.equal(calls[0]?.[8], requestId);
  assert.deepEqual(JSON.parse(response.body), { session: record.view });
  for (const hidden of ['monitorSecret', 'monitorCertificate', 'taskArn', 'pins', 'accessGrant', 'ownerId'])
    assert.equal(response.body.includes(hidden), false);
});
test('invalid requests and missing identity do not reach storage', async () => {
  const handler = createEndSessionHandler({
    store: {
      outcome: async () => {
        assert.fail('Storage must not be called');
      },
    },
  });
  for (const value of [{ requestId, extra: true }, {}, { requestId: 'wrong' }, []])
    assert.equal((await handler(event(value), context)).statusCode, 400);
  assert.equal((await handler(event({ requestId }, null), context)).statusCode, 401);
  assert.equal((await handler({ ...event(), body: 'x'.repeat(8193) }, context)).statusCode, 400);
  assert.equal((await handler({ ...event(), isBase64Encoded: true, body: '*' }, context)).statusCode, 400);
});
test('owner misses, request conflicts, and storage failure use fixed errors without private details', async () => {
  for (const [code, status] of [
    ['not_found', 404],
    ['conflict', 409],
    ['invalid_store', 500],
  ] as const) {
    const handler = createEndSessionHandler({
      store: {
        outcome: async () => {
          throw new AttemptStoreError(code);
        },
      },
    });
    const response = await handler(event(), context);
    assert.equal(response.statusCode, status);
    assert.equal(JSON.parse(response.body).requestId, requestId);
  }
});
