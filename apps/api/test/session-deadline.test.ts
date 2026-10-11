import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import { SessionDeadline, loadDeadlineConfiguration } from '../src/session-lifecycle/session-deadline.js';
import { sessionRecord } from './session-fixture.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const config = {
  groupName: 'sessions',
  functionArn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:reconcile',
  targetRoleArn: 'arn:aws:iam::123456789012:role/timer',
};
const missing = () => new ResourceNotFoundException({ $metadata: {}, Message: 'Missing', message: 'Missing' });
function fixture() {
  const session = sessionRecord(id);
  session.view.status = 'ready';
  session.view.readyAt = '2026-10-10T08:00:00.000Z';
  session.view.endsAt = '2026-10-10T08:20:00.000Z';
  const values = new Map<string, Record<string, unknown>>();
  const calls: unknown[] = [];
  let lose = false;
  const client = {
    send: async (
      command: GetScheduleCommand | CreateScheduleCommand | UpdateScheduleCommand | DeleteScheduleCommand,
    ) => {
      calls.push(command);
      const name = command.input.Name!;
      if (command instanceof GetScheduleCommand) {
        if (!values.has(name)) throw missing();
        return values.get(name);
      }
      if (command instanceof DeleteScheduleCommand) {
        if (!values.delete(name)) throw missing();
        return {};
      }
      values.set(name, { ...command.input });
      if (lose) {
        lose = false;
        throw new Error('Lost response');
      }
      return {};
    },
  } as unknown as SchedulerClient;
  return {
    session,
    values,
    calls,
    schedule: new SessionDeadline(client, config),
    lose: () => {
      lose = true;
    },
  };
}
test('ready deadline uses a separate timer, saved time limit, fixed target, and safe retries', async () => {
  const f = fixture();
  f.lose();
  await f.schedule.ensure(f.session, new Date('2026-10-10T08:00:00Z'));
  const saved = f.values.get(`session-${id}-ready`)!;
  assert.equal(saved.ScheduleExpression, 'at(2026-10-10T08:20:00)');
  assert.deepEqual(saved.Target, {
    Arn: config.functionArn,
    RoleArn: config.targetRoleArn,
    Input: JSON.stringify({ sessionId: id }),
    RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 20 },
  });
  const writes = f.calls.filter(
    (command) => command instanceof CreateScheduleCommand || command instanceof UpdateScheduleCommand,
  ).length;
  await f.schedule.ensure(f.session, new Date('2026-10-10T08:01:00Z'));
  assert.equal(
    f.calls.filter((command) => command instanceof CreateScheduleCommand || command instanceof UpdateScheduleCommand)
      .length,
    writes,
  );
  assert.equal(f.values.has(`session-${id}`), false);
});
test('timer repair replaces a stale target and cleanup deletes all three timers idempotently', async () => {
  const f = fixture();
  f.values.set(`session-${id}-ready`, { GroupName: config.groupName, Target: { Arn: 'wrong' } });
  await f.schedule.ensure(f.session, new Date('2026-10-10T08:00:00Z'));
  assert.ok(f.calls.some((command) => command instanceof UpdateScheduleCommand));
  await f.schedule.delete(f.session);
  await f.schedule.delete(f.session);
  assert.equal(f.values.size, 0);
  assert.deepEqual(
    f.calls
      .filter((command) => command instanceof DeleteScheduleCommand)
      .slice(0, 3)
      .map((command) => (command as DeleteScheduleCommand).input.Name),
    [`session-${id}`, `session-${id}-recovery`, `session-${id}-ready`],
  );
});
test('expired and non-ready sessions do not create timers, and runtime self identity is bounded', async () => {
  const f = fixture();
  await f.schedule.ensure(f.session, new Date('2026-10-10T08:20:00Z'));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    loadDeadlineConfiguration({
      SCHEDULER_GROUP_NAME: config.groupName,
      SCHEDULER_TARGET_ROLE_ARN: config.targetRoleArn,
      AWS_PARTITION: 'aws',
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCOUNT_ID: '123456789012',
      AWS_LAMBDA_FUNCTION_NAME: 'reconcile',
    }),
    config,
  );
  assert.throws(() => loadDeadlineConfiguration({}));
});
