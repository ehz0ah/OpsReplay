import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GetCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createReconcileHandler } from '../src/reconcile-session/handler.js';
import { createSessionSweep } from '../src/sweep-sessions/handler.js';
const context = { getRemainingTimeInMillis: () => 10000 };
test('stream reconciliation is bounded, deduplicated, and ignores unrelated records', async () => {
  const id = randomUUID();
  const ids: string[] = [];
  const handler = createReconcileHandler({
    reconcile: async (id) => {
      ids.push(id);
      return 'active';
    },
    taskSession: async () => false,
  });
  const entry = (SK: string) => ({
    eventSource: 'aws:dynamodb',
    eventName: 'MODIFY',
    dynamodb: { Keys: { PK: { S: `SESSION#${id}` }, SK: { S: SK } } },
  });
  await handler({ Records: [entry('STATE'), entry('RECORDING'), entry('LIFECYCLE'), entry('INPUT')] }, context);
  assert.deepEqual(ids, []);
  await handler({ Records: [entry('LIFECYCLE_HINT#ready'), entry('LIFECYCLE_HINT#outcome')] }, context);
  assert.deepEqual(ids, [id]);
  await assert.rejects(handler({ Records: Array.from({ length: 26 }, () => entry('LIFECYCLE_HINT#ready')) }, context));
});
test('timer callbacks use only session identity and stopped-task callbacks must match stored task ownership', async () => {
  const id = randomUUID();
  const ids: string[] = [];
  let valid = false;
  const handler = createReconcileHandler({
    reconcile: async (id) => {
      ids.push(id);
      return 'active';
    },
    taskSession: async () => valid,
  });
  await handler({ sessionId: id }, context);
  await assert.rejects(handler({ sessionId: id, cutoffAt: 'forged' }, context));
  const stopped = {
    source: 'aws.ecs',
    'detail-type': 'ECS Task State Change',
    detail: {
      startedBy: id,
      lastStatus: 'STOPPED',
      clusterArn: 'cluster',
      taskArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task/test/1234',
    },
  };
  await handler(stopped, context);
  assert.deepEqual(ids, [id]);
  valid = true;
  await handler(stopped, context);
  assert.deepEqual(ids, [id, id]);
});
test('sweep saves progress before work and limits concurrent session checks to five', async () => {
  const ids = Array.from({ length: 10 }, () => randomUUID());
  let saved = false;
  let active = 0;
  let maximum = 0;
  const seen: string[] = [];
  const pending: (() => void)[] = [];
  const client = {
    send: async (command: GetCommand | QueryCommand | PutCommand) => {
      if (command instanceof GetCommand) return {};
      if (command instanceof PutCommand) {
        saved = true;
        return {};
      }
      return { Items: ids.map((id) => ({ PK: `SESSION#${id}`, SK: 'LIFECYCLE' })) };
    },
  } as unknown as DynamoDBDocumentClient;
  const run = createSessionSweep({
    client,
    table: 'test-table',
    reconcile: async (id, signal) => {
      assert.equal(saved, true);
      assert.equal(signal?.aborted, false);
      active++;
      maximum = Math.max(maximum, active);
      seen.push(id);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
      return 'active';
    },
    report: () => {},
  })({}, { getRemainingTimeInMillis: () => 60000 });
  for (const expected of [5, 10]) {
    for (let attempt = 0; attempt < 100 && seen.length < expected; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.length, expected);
    assert.equal(pending.length, 5);
    for (const release of pending.splice(0)) release();
  }
  await run;
  assert.equal(maximum, 5);
  assert.deepEqual(seen, ids);
});

test('invalid sweep cursors and expired invocation budgets cannot reach session work', async () => {
  let queries = 0;
  const client = {
    send: async (command: GetCommand | QueryCommand | PutCommand) => {
      if (command instanceof GetCommand) return { Item: { cursor: { WorkPK: 'RECORDING' } } };
      queries++;
      throw new Error('Invalid cursor must fail before query');
    },
  } as unknown as DynamoDBDocumentClient;
  const run = createSessionSweep({
    client,
    table: 'test-table',
    reconcile: async () => {
      throw new Error('Session work must not start');
    },
    report: () => {},
  });
  await assert.rejects(run({}, context), /Lifecycle sweep cursor is invalid/);
  await assert.rejects(run({}, { getRemainingTimeInMillis: () => 500 }));
  assert.equal(queries, 0);
});

test('bounded sweep persists pagination across cold starts and isolates one session failure', async () => {
  const ids = [randomUUID(), randomUUID()];
  const seen: string[] = [];
  const requests: QueryCommand[] = [];
  let cursor: unknown = null;
  let page = 0;
  const next = { PK: `SESSION#${ids[0]}`, SK: 'LIFECYCLE', WorkPK: 'LIFECYCLE', WorkSK: '2026-10-12T00:00:00.000Z' };
  const client = {
    send: async (command: GetCommand | QueryCommand | PutCommand) => {
      if (command instanceof GetCommand) return { Item: { cursor } };
      if (command instanceof PutCommand) {
        cursor = command.input.Item?.cursor;
        return {};
      }
      requests.push(command);
      return {
        Items: [{ PK: `SESSION#${ids[page]}`, SK: 'LIFECYCLE' }],
        ...(page++ === 0 ? { LastEvaluatedKey: next } : {}),
      };
    },
  } as unknown as DynamoDBDocumentClient;
  const options = {
    client,
    table: 'test-table',
    reconcile: async (id: string) => {
      seen.push(id);
      if (id === ids[0]) throw new Error('Temporary failure');
      return 'active' as const;
    },
    report: () => {},
  };
  await assert.rejects(createSessionSweep(options)({}, context));
  await createSessionSweep(options)({}, context);
  assert.deepEqual(seen, ids);
  assert.equal(requests[0]?.input.Limit, 25);
  assert.deepEqual(requests[1]?.input.ExclusiveStartKey, next);
  assert.equal(cursor, null);
});
