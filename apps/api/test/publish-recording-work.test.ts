import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createPublishRecordingWorkHandler } from '../src/publish-recording-work/handler.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const clusterArn = 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test';
const taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const context = { getRemainingTimeInMillis: () => 10_000 };

function event(lastStatus = 'RUNNING', addresses = ['10.0.1.42']) {
  return {
    source: 'aws.ecs',
    'detail-type': 'ECS Task State Change',
    detail: {
      clusterArn,
      taskArn,
      startedBy: sessionId,
      lastStatus,
      attachments: [
        {
          type: 'ElasticNetworkInterface',
          details: addresses.map((value) => ({ name: 'privateIPv4Address', value })),
        },
      ],
    },
  };
}

test('the task-state handler publishes one validated private address with a bounded deadline', async () => {
  const calls: unknown[] = [];
  const logs: unknown[] = [];
  const handler = createPublishRecordingWorkHandler({
    publish: async (value, signal) => {
      calls.push({ value, signal });
      return 'published';
    },
    log: (entry) => logs.push(entry),
  });
  await handler(event(), context);
  assert.deepEqual((calls[0] as { value: unknown }).value, {
    sessionId,
    clusterArn,
    taskArn,
    taskAddress: '10.0.1.42',
  });
  assert.equal((calls[0] as { signal: AbortSignal }).signal.aborted, false);
  assert.equal((logs[0] as { result: string }).result, 'published');
});

test('the task-state handler ignores other states and rejects ambiguous addresses', async () => {
  let calls = 0;
  const handler = createPublishRecordingWorkHandler({
    publish: async () => {
      calls++;
      return 'published';
    },
  });
  await handler(event('PENDING'), context);
  assert.equal(calls, 0);
  await assert.rejects(handler(event('RUNNING', []), context), /unique private address/);
  await assert.rejects(handler(event('RUNNING', ['10.0.1.42', '10.0.1.43']), context), /unique private address/);
  await assert.rejects(handler({ source: 'aws.ecs' }, context), /Invalid ECS task-state event/);
});

test('the bundled task-state Lambda rejects malformed input before AWS calls', async () => {
  const previous = process.env.SESSION_TABLE_NAME;
  try {
    process.env.SESSION_TABLE_NAME = 'test-unused';
    const bundled = createRequire(import.meta.url)('../../../dist/publish-recording-work/index.cjs');
    await assert.rejects(bundled.handler({ source: 'aws.ecs' }, context), /Invalid ECS task-state event/);
  } finally {
    if (previous === undefined) delete process.env.SESSION_TABLE_NAME;
    else process.env.SESSION_TABLE_NAME = previous;
  }
});
