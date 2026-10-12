import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createReleaseHintHandler } from '../src/release-hint/handler.js';
import { HintReleaseError } from '../src/release-hint/store.js';

const id = randomUUID();
const requestId = randomUUID();
const owner = 'learner-1';
const at = '2026-10-13T00:03:00.000Z';
const context = { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 5000 };
const event = (body: unknown = { requestId }, subject: unknown = owner) =>
  ({
    httpMethod: 'POST',
    resource: '/v1/sessions/{id}/hints',
    pathParameters: { id },
    requestContext: { authorizer: { claims: { sub: subject } } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  }) as unknown as APIGatewayProxyEvent;

test('hint handler validates ownership and returns the exact store result', async () => {
  const calls: unknown[][] = [];
  const handler = createReleaseHintHandler({
    store: {
      release: async (...args) => {
        calls.push(args);
        return {
          hint: { id: 'read-proxy-error', text: 'Inspect the proxy error log.', releasedAt: at },
          remaining: 1,
          replayed: false,
        };
      },
    },
    now: () => new Date(at),
  });
  const result = await handler(event(), context);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls[0]?.slice(0, 4), [id, owner, requestId, at]);
  assert.deepEqual(JSON.parse(result.body), {
    hint: { id: 'read-proxy-error', text: 'Inspect the proxy error log.', releasedAt: at },
    remaining: 1,
    replayed: false,
  });
  assert.equal(result.headers?.['Cache-Control'], 'no-store');
});

test('invalid hint requests and missing identity do not reach storage', async () => {
  const handler = createReleaseHintHandler({
    store: {
      release: async () => {
        assert.fail('Storage must not be called.');
      },
    },
  });
  for (const value of [{}, { requestId: 'wrong' }, { requestId, extra: true }, []])
    assert.equal((await handler(event(value), context)).statusCode, 400);
  assert.equal((await handler(event({ requestId }, null), context)).statusCode, 401);
  assert.equal((await handler({ ...event(), httpMethod: 'GET' }, context)).statusCode, 400);
  assert.equal((await handler({ ...event(), pathParameters: { id: 'wrong' } }, context)).statusCode, 400);
  assert.equal((await handler({ ...event(), body: 'x'.repeat(12_001) }, context)).statusCode, 400);
  assert.equal((await handler({ ...event(), body: '*', isBase64Encoded: true }, context)).statusCode, 400);
});

test('hint domain errors retain fixed public codes and retry timing', async () => {
  for (const [code, status] of [
    ['NOT_FOUND', 404],
    ['IDEMPOTENCY_CONFLICT', 409],
    ['SESSION_NOT_READY', 409],
    ['SESSION_TERMINAL', 409],
    ['NO_HINTS_REMAINING', 422],
    ['INTERNAL_ERROR', 500],
  ] as const) {
    const handler = createReleaseHintHandler({
      store: { release: async () => Promise.reject(new HintReleaseError(code)) },
    });
    const result = await handler(event(), context);
    assert.equal(result.statusCode, status);
    assert.deepEqual(Object.keys(JSON.parse(result.body)).sort(), ['code', 'message', 'requestId']);
  }
  const unavailable = createReleaseHintHandler({
    store: { release: async () => Promise.reject(new HintReleaseError('HINT_NOT_AVAILABLE', 61)) },
  });
  const result = await unavailable(event(), context);
  assert.equal(result.statusCode, 409);
  assert.equal(JSON.parse(result.body).retryAfterSeconds, 61);
});

test('hint logs contain only the operation, request ID, result, and duration', async () => {
  const entries: object[] = [];
  const handler = createReleaseHintHandler({
    store: {
      release: async () => ({
        hint: { id: 'private-id', text: 'private hint text', releasedAt: at },
        remaining: 0,
        replayed: true,
      }),
    },
    now: () => new Date(at),
    log: (entry) => entries.push(entry),
  });
  assert.equal((await handler(event(), context)).statusCode, 200);
  assert.deepEqual(Object.keys(entries[0]!).sort(), ['durationMs', 'operation', 'requestId', 'result']);
  assert.equal(JSON.stringify(entries).includes('private'), false);
});
