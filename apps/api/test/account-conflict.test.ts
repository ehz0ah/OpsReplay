import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { TransactGetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createGetAccountHandler } from '../src/get-account/handler.js';
const event = {
  httpMethod: 'GET',
  body: null,
  isBase64Encoded: false,
  resource: '/v1/me',
  requestContext: { authorizer: { claims: { sub: 'learner' } } },
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
} as unknown as APIGatewayProxyEvent;
const context = { getRemainingTimeInMillis: () => 10000 };
function conflict(codes = ['TransactionConflict', 'None']) {
  return Object.assign(new Error('conflict'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}
test('account retries a pure transaction conflict using the identical snapshot read', async () => {
  let calls = 0,
    first: TransactGetCommand | undefined;
  const client = {
    send: async (command: TransactGetCommand) => {
      assert.ok(command instanceof TransactGetCommand);
      first ??= command;
      assert.equal(command, first);
      if (++calls < 3) throw conflict();
      return { Responses: [{}, {}] };
    },
  } as unknown as DynamoDBDocumentClient;
  const result = await createGetAccountHandler(client, 'table-name')(event, context);
  assert.equal(result.statusCode, 200);
  assert.equal(calls, 3);
  assert.equal(JSON.parse(result.body).activeSessionId, null);
});
test('account stops after four conflicts and never retries mixed or unrelated errors', async () => {
  for (const [failure, expected] of [
    [conflict(), 4],
    [conflict(['TransactionConflict', 'ConditionalCheckFailed']), 1],
    [new Error('ordinary failure'), 1],
  ] as const) {
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        throw failure;
      },
    } as unknown as DynamoDBDocumentClient;
    const result = await createGetAccountHandler(client, 'table-name')(event, context);
    assert.equal(result.statusCode, 500);
    assert.equal(calls, expected);
    assert.equal(result.body.includes(failure.message), false);
  }
});

test('account reports deployment admission independently of the learner plan and preserves legacy responses', async () => {
  const client = {
    send: async (command: TransactGetCommand) => {
      assert.ok(command instanceof TransactGetCommand);
      return { Responses: [{}, {}] };
    },
  } as unknown as DynamoDBDocumentClient;
  for (const enabled of [false, true, undefined]) {
    const handler = createGetAccountHandler(client, 'table-name', Date.now, undefined, undefined, enabled);
    const legacy = await handler(event, context);
    assert.equal(legacy.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(legacy.body), 'challengeStartsEnabled'), false);
    const result = await handler({ ...event, queryStringParameters: { include: 'admission' } }, context);
    assert.equal(result.statusCode, 200);
    const account = JSON.parse(result.body);
    assert.equal(account.plan, 'free');
    assert.equal(account.activeSessionId, null);
    assert.equal(account.challengeStartsEnabled, enabled);
    assert.equal(Object.hasOwn(account, 'challengeStartsEnabled'), enabled !== undefined);
    const multi = await handler({ ...event, multiValueQueryStringParameters: { include: ['admission'] } }, context);
    assert.equal(multi.statusCode, 200);
    assert.equal(JSON.parse(multi.body).challengeStartsEnabled, enabled);
  }
});
