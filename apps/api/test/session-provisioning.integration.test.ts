import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createExpireProvisioning } from '../src/session-lifecycle/expire.js';
import type { EnvironmentPort, EnvironmentTask, ProvisioningSchedulePort } from '../src/session-lifecycle/ports.js';
import { CleanupPendingError, LaunchRejectedError } from '../src/session-lifecycle/ports.js';
import { createProvisionSession } from '../src/session-lifecycle/provision.js';
import { LifecycleStore } from '../src/session-lifecycle/store.js';
import { keys } from '../src/start-session/store.js';
import type { EcsLaunchArguments, SessionRecord } from '../src/start-session/types.js';
import { validSession } from '../src/start-session/validation.js';
import { startLocalDatabase } from './local-dynamodb.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(async () => { database = await startLocalDatabase(); }, { timeout: 60_000 });
after(() => database?.close());

const ownerId = '11111111-1111-4111-8111-111111111111';
const taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function newSession(): SessionRecord {
  const id = randomUUID();
  const monitorSecret = 's'.repeat(43);
  return {
    ownerId,
    view: {
      id,
      challenge: { id: 'wrong-upstream-port', version: '0.1.0', title: 'Storefront returns 502', tier: 'easy', category: 'networking' },
      attempt: { kind: 'first', number: 1 },
      status: 'provisioning', statusReason: null,
      alert: { title: 'Checkout errors', summary: 'Checkout requests fail.', severity: 'critical' },
      dashboard: [{ id: 'error_rate', label: 'Errors', unit: 'percent' }],
      recovery: null, timeLimitSeconds: 1200,
      createdAt: '2026-10-06T02:00:00.000Z', readyAt: null, endsAt: null, endedAt: null,
      hints: { released: [], remaining: 2, nextAvailableAt: null },
      assistance: { hintsReleased: 0, assistantTurns: 0, proposalsRun: 0 },
      debriefAvailable: false, recording: { status: 'pending', reason: null },
    },
    accessGrant: { plan: 'free', admittedAt: '2026-10-06T02:00:00.000Z', timeLimitSeconds: 1200 },
    pins: {
      taskDefinitionArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      challengeImageDigest: `sha256:${'a'.repeat(64)}`,
      monitorImageDigest: `sha256:${'b'.repeat(64)}`,
    },
    launchArguments: {
      cluster: 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test',
      taskDefinition: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      clientToken: id, startedBy: id, count: 1, enableExecuteCommand: false,
      launchType: 'FARGATE', platformVersion: '1.4.0',
      networkConfiguration: { awsvpcConfiguration: {
        subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], assignPublicIp: 'DISABLED',
      } },
      overrides: { containerOverrides: [{ name: 'monitor', environment: [
        { name: 'OPSREPLAY_SESSION_ID', value: id },
        { name: 'OPSREPLAY_MONITOR_SECRET', value: monitorSecret },
      ] }] },
      tags: [{ key: 'opsreplay:session-id', value: id }],
    },
    monitorSecret,
    provisioningDeadline: '2026-10-06T02:03:00.000Z',
    launchRecoveryDeadline: '2026-10-06T02:08:00.000Z',
    scheduleName: `session-${id}`,
    taskArn: null,
    provisioningCleanup: { status: 'pending', completedAt: null },
  };
}

class FakeSchedule implements ProvisioningSchedulePort {
  readonly schedules = new Map<string, string>();
  calls = 0;
  failAfterCreate = false;

  async ensure(session: SessionRecord, _now: Date, _abortSignal?: AbortSignal): Promise<void> {
    this.calls++;
    const value = JSON.stringify({ sessionId: session.view.id, deadline: session.provisioningDeadline });
    const existing = this.schedules.get(session.scheduleName);
    if (existing && existing !== value) throw new Error('Schedule changed across a retry');
    this.schedules.set(session.scheduleName, value);
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error('Schedule response lost');
    }
  }
}

class FakeEnvironment implements EnvironmentPort {
  readonly tasks = new Map<string, EnvironmentTask & { cluster: string; startedBy: string; arguments: string }>();
  launchCalls = 0;
  stopCalls = 0;
  failAfterLaunch = false;
  rejectLaunch = false;

  async launch(arguments_: EcsLaunchArguments, _abortSignal?: AbortSignal): Promise<string> {
    this.launchCalls++;
    if (this.rejectLaunch) throw new LaunchRejectedError();
    const serialized = JSON.stringify(arguments_);
    const existing = this.tasks.get(arguments_.clientToken);
    if (existing && existing.arguments !== serialized) throw new Error('Launch arguments changed across a retry');
    if (!existing) this.tasks.set(arguments_.clientToken, {
      taskArn, lastStatus: 'RUNNING', cluster: arguments_.cluster, startedBy: arguments_.startedBy, arguments: serialized,
    });
    if (this.failAfterLaunch) {
      this.failAfterLaunch = false;
      throw new Error('RunTask response lost');
    }
    return this.tasks.get(arguments_.clientToken)!.taskArn;
  }

  async findActive(cluster: string, startedBy: string): Promise<EnvironmentTask[]> {
    return [...this.tasks.values()].filter(task => task.cluster === cluster
      && task.startedBy === startedBy && task.lastStatus !== 'STOPPED');
  }

  async describe(cluster: string, arn: string): Promise<EnvironmentTask | undefined> {
    return [...this.tasks.values()].find(task => task.cluster === cluster && task.taskArn === arn);
  }

  async stop(cluster: string, arn: string): Promise<void> {
    const task = [...this.tasks.values()].find(candidate => candidate.cluster === cluster && candidate.taskArn === arn);
    if (task) task.lastStatus = 'STOPPED';
    this.stopCalls++;
  }
}

async function fixture(record = newSession()) {
  assert.ok(validSession(record), JSON.stringify(validSession.errors));
  const table = `test-${randomUUID()}`;
  await database.client.send(new CreateTableCommand({
    TableName: table, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
  }));
  const put = (key: { PK: string; SK: string }, data: unknown) => database.document.send(new PutCommand({
    TableName: table, Item: { ...key, data },
  }));
  const get = async (key: { PK: string; SK: string }) => (await database.document.send(new GetCommand({
    TableName: table, Key: key, ConsistentRead: true,
  }))).Item?.data;
  await put(keys.session(record.view.id), record);
  await put(keys.active(record.ownerId), { sessionId: record.view.id, requestId: record.launchArguments.clientToken });
  return { record, store: new LifecycleStore(database.document, table), get };
}

test('provisioning creates the expiry schedule before one ECS task and saves its ARN', async () => {
  const f = await fixture();
  const order: string[] = [];
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  const provision = createProvisionSession({
    store: { ...f.store,
      session: f.store.session.bind(f.store),
      saveTask: async (...arguments_) => { order.push('save'); return f.store.saveTask(...arguments_); },
      failStartWithoutTask: f.store.failStartWithoutTask.bind(f.store),
    },
    schedule: { ensure: async (...arguments_) => { order.push('schedule'); return schedule.ensure(...arguments_); } },
    environment: { launch: async (...arguments_) => { order.push('launch'); return environment.launch(...arguments_); },
      stop: environment.stop.bind(environment) },
    now: () => new Date('2026-10-06T02:00:10.000Z'),
  });
  assert.equal(await provision(f.record.view.id), 'launched');
  assert.deepEqual(order, ['schedule', 'launch', 'save']);
  assert.equal((await f.store.session(f.record.view.id))?.taskArn, taskArn);
  assert.equal(environment.tasks.size, 1);
});

test('provisioning rejects inconsistent stored launch identity before external effects', async () => {
  const record = newSession();
  record.launchArguments.startedBy = randomUUID();
  const f = await fixture(record);
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  const provision = createProvisionSession({ store: f.store, schedule, environment,
    now: () => new Date('2026-10-06T02:00:10.000Z') });
  await assert.rejects(provision(record.view.id), /Invalid stored session record/);
  assert.equal(schedule.calls, 0);
  assert.equal(environment.launchCalls, 0);
});

test('a lost schedule response is repaired before launch', async () => {
  const f = await fixture();
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  schedule.failAfterCreate = true;
  const provision = createProvisionSession({ store: f.store, schedule, environment,
    now: () => new Date('2026-10-06T02:00:10.000Z') });
  await assert.rejects(provision(f.record.view.id), /Schedule response lost/);
  assert.equal(environment.tasks.size, 0);
  assert.equal(await provision(f.record.view.id), 'launched');
  assert.equal(schedule.schedules.size, 1);
  assert.equal(environment.tasks.size, 1);
});

test('a lost RunTask response reuses the client token and creates one task', async () => {
  const f = await fixture();
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  environment.failAfterLaunch = true;
  const provision = createProvisionSession({ store: f.store, schedule, environment,
    now: () => new Date('2026-10-06T02:00:10.000Z') });
  await assert.rejects(provision(f.record.view.id), /RunTask response lost/);
  assert.equal(await provision(f.record.view.id), 'launched');
  assert.equal(environment.launchCalls, 2);
  assert.equal(environment.tasks.size, 1);
});

test('a lost task-ARN write response does not launch again', async () => {
  const f = await fixture();
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  let loseResponse = true;
  const store = {
    session: f.store.session.bind(f.store),
    failStartWithoutTask: f.store.failStartWithoutTask.bind(f.store),
    saveTask: async (...arguments_: Parameters<LifecycleStore['saveTask']>) => {
      const saved = await f.store.saveTask(...arguments_);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('DynamoDB response lost');
      }
      return saved;
    },
  };
  const provision = createProvisionSession({ store, schedule, environment,
    now: () => new Date('2026-10-06T02:00:10.000Z') });
  await assert.rejects(provision(f.record.view.id), /DynamoDB response lost/);
  assert.equal(await provision(f.record.view.id), 'already_launched');
  assert.equal(environment.launchCalls, 1);
});

test('concurrent provisioning calls still create one task', async () => {
  const f = await fixture();
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  const provision = createProvisionSession({ store: f.store, schedule, environment,
    now: () => new Date('2026-10-06T02:00:10.000Z') });
  await Promise.all(Array.from({ length: 8 }, () => provision(f.record.view.id)));
  assert.equal(environment.tasks.size, 1);
  assert.equal((await f.store.session(f.record.view.id))?.taskArn, taskArn);
});

test('a confirmed capacity rejection fails the session and releases its lock', async () => {
  const f = await fixture();
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  environment.rejectLaunch = true;
  const provision = createProvisionSession({ store: f.store, schedule, environment,
    now: () => new Date('2026-10-06T02:00:10.000Z') });
  const results = await Promise.all(Array.from({ length: 8 }, () => provision(f.record.view.id)));
  assert.ok(results.includes('capacity_unavailable'));
  assert.ok(results.every(result => ['capacity_unavailable', 'terminal'].includes(result)));
  const saved = await f.store.session(f.record.view.id);
  assert.equal(saved?.view.status, 'error');
  assert.equal(saved?.view.statusReason, 'start_failed');
  assert.equal(saved?.provisioningCleanup.status, 'complete');
  assert.equal(await f.get(keys.active(ownerId)), undefined);
});

test('expired provisioning never calls RunTask', async () => {
  const f = await fixture();
  const schedule = new FakeSchedule();
  const environment = new FakeEnvironment();
  const provision = createProvisionSession({ store: f.store, schedule, environment,
    now: () => new Date('2026-10-06T02:03:00.000Z') });
  assert.equal(await provision(f.record.view.id), 'expired');
  assert.equal(schedule.calls, 1);
  assert.equal(environment.launchCalls, 0);
});

test('expiry discovers an uncertain task, stops it, then releases the lock', async () => {
  const f = await fixture();
  const environment = new FakeEnvironment();
  await environment.launch(f.record.launchArguments);
  const expire = createExpireProvisioning({ store: f.store, environment,
    now: () => new Date('2026-10-06T02:03:01.000Z') });
  await assert.rejects(expire(f.record.view.id), CleanupPendingError);
  assert.equal(environment.stopCalls, 1);
  assert.equal((await f.store.session(f.record.view.id))?.taskArn, taskArn);
  assert.equal(await expire(f.record.view.id), 'cleaned');
  assert.equal((await f.store.session(f.record.view.id))?.provisioningCleanup.status, 'complete');
  assert.equal(await f.get(keys.active(ownerId)), undefined);
});

test('expiry keeps the lock while an uncertain launch can still appear', async () => {
  const f = await fixture();
  const environment = new FakeEnvironment();
  let clock = new Date('2026-10-06T02:03:01.000Z');
  const expire = createExpireProvisioning({ store: f.store, environment, now: () => clock });
  await assert.rejects(expire(f.record.view.id), CleanupPendingError);
  assert.ok(await f.get(keys.active(ownerId)));
  clock = new Date('2026-10-06T02:08:00.000Z');
  assert.equal(await expire(f.record.view.id), 'cleaned');
  assert.equal(await f.get(keys.active(ownerId)), undefined);
  assert.equal(await expire(f.record.view.id), 'ignored');
});

test('an early or stale expiry event cannot end an active session', async () => {
  const early = await fixture();
  const environment = new FakeEnvironment();
  const expireEarly = createExpireProvisioning({ store: early.store, environment,
    now: () => new Date('2026-10-06T02:02:59.000Z') });
  await assert.rejects(expireEarly(early.record.view.id), CleanupPendingError);
  assert.equal((await early.store.session(early.record.view.id))?.view.status, 'provisioning');

  const readyRecord = newSession();
  readyRecord.view.status = 'ready';
  readyRecord.view.readyAt = '2026-10-06T02:02:00.000Z';
  readyRecord.view.endsAt = '2026-10-06T02:22:00.000Z';
  const ready = await fixture(readyRecord);
  const expireReady = createExpireProvisioning({ store: ready.store, environment,
    now: () => new Date('2026-10-06T02:03:01.000Z') });
  assert.equal(await expireReady(ready.record.view.id), 'ignored');
  assert.equal((await ready.store.session(ready.record.view.id))?.view.status, 'ready');
});
