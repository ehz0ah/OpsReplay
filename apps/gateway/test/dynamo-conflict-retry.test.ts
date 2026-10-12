import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isDynamoTransactionConflict, sendDynamoWrite } from '../../../packages/dynamodb/src/conflict-retry.js';

const cancelled = (...codes: (string | undefined)[]) =>
  Object.assign(new Error('Cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
const conflict = () => Object.assign(new Error('Contention'), { name: 'TransactionConflictException' });

test('only pure transaction contention is retryable', () => {
  assert.ok(isDynamoTransactionConflict(conflict()));
  assert.ok(isDynamoTransactionConflict(cancelled('None', 'TransactionConflict')));
  for (const error of [
    cancelled('ConditionalCheckFailed', 'TransactionConflict'),
    cancelled('ProvisionedThroughputExceeded', 'TransactionConflict'),
    cancelled(undefined, 'TransactionConflict'),
    cancelled('None'),
    cancelled(),
    new Error('Unknown'),
  ])
    assert.equal(isDynamoTransactionConflict(error), false);
});

test('write retry preserves the exact request and token for single-item and transaction conflicts', async () => {
  for (const command of [
    new UpdateCommand({ TableName: 'test', Key: { PK: 'x' } }),
    new TransactWriteCommand({ ClientRequestToken: 'same-request', TransactItems: [] }),
  ]) {
    let calls = 0;
    const client = {
      send: async (actual: unknown) => {
        assert.equal(actual, command);
        if (++calls < 3) throw command instanceof UpdateCommand ? conflict() : cancelled('TransactionConflict');
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    if (command instanceof UpdateCommand) await sendDynamoWrite(client, command);
    else await sendDynamoWrite(client, command);
    assert.equal(calls, 3);
  }
});

test('exhaustion is bounded and failed conditions are not retried', async () => {
  for (const error of [conflict(), cancelled('ConditionalCheckFailed', 'TransactionConflict')]) {
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        throw error;
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(sendDynamoWrite(client, new TransactWriteCommand({ TransactItems: [] })), (e) => e === error);
    assert.equal(calls, isDynamoTransactionConflict(error) ? 4 : 1);
  }
});

test('cancellation stops backoff before another write', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = {
    send: async () => {
      calls++;
      controller.abort();
      throw conflict();
    },
  } as unknown as DynamoDBDocumentClient;
  await assert.rejects(
    sendDynamoWrite(client, new TransactWriteCommand({ TransactItems: [] }), { abortSignal: controller.signal }),
  );
  assert.equal(calls, 1);
});
