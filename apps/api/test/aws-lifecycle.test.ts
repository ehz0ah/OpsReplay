import assert from 'node:assert/strict';
import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  type ECSClient,
} from '@aws-sdk/client-ecs';
import {
  ConflictException,
  CreateScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  type SchedulerClient,
} from '@aws-sdk/client-scheduler';
import {
  GetObjectTaggingCommand,
  PutObjectCommand,
  S3ServiceException,
  type S3Client,
  type Tag,
} from '@aws-sdk/client-s3';
import { recordingWorkTiming } from '../../../packages/contracts/private/recording-work.js';
import { MonitorBootstrapFile } from '../src/session-lifecycle/aws-bootstrap.js';
import { createMonitorCertificate } from '../src/session-lifecycle/monitor-certificate.js';
import { FargateEnvironment } from '../src/session-lifecycle/aws-environment.js';
import { ProvisioningSchedule, loadScheduleConfiguration } from '../src/session-lifecycle/aws-schedule.js';
import { createExpiryHandler } from '../src/expire-provisioning/handler.js';
import { LaunchRejectedError } from '../src/session-lifecycle/ports.js';
import { loadLaunchConfiguration } from '../src/start-session/configuration.js';
import type { SessionRecord } from '../src/start-session/types.js';

// AWS official RunTask capacity message, not a synthetic failure code.
const capacityMessage =
  'Capacity is unavailable at this time. Please try again later or in a different availability zone';

const sessionId = '11111111-1111-4111-8111-111111111111';
const cluster = 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test';
const taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function certificateTagSet(certificate: string): Tag[] {
  const encoded = Buffer.from(certificate).toString('base64url');
  const parts = encoded.match(/.{1,256}/g) ?? [];
  return [
    { Key: 'opsreplay-certificate-parts', Value: String(parts.length) },
    ...parts.map((value, index) => ({ Key: `opsreplay-certificate-${index}`, Value: value })),
  ];
}

function parseTagging(value: string | undefined): Tag[] {
  assert.ok(value);
  return [...new URLSearchParams(value)].map(([Key, Value]) => ({ Key, Value }));
}

function session(): SessionRecord {
  const monitorSecret = 's'.repeat(43);
  return {
    ownerId: '22222222-2222-4222-8222-222222222222',
    view: {
      id: sessionId,
      challenge: {
        id: 'wrong-upstream-port',
        version: '0.1.0',
        title: 'Storefront returns 502',
        tier: 'easy',
        category: 'networking',
      },
      attempt: { kind: 'first', number: 1 },
      status: 'provisioning',
      statusReason: null,
      alert: { title: 'Checkout errors', summary: 'Checkout requests fail.', severity: 'critical' },
      dashboard: [],
      recovery: null,
      timeLimitSeconds: 1200,
      createdAt: '2026-10-06T02:00:00.000Z',
      readyAt: null,
      endsAt: null,
      endedAt: null,
      hints: { released: [], remaining: 0, nextAvailableAt: null },
      assistance: { hintsReleased: 0, assistantTurns: 0, proposalsRun: 0 },
      debriefAvailable: false,
      recording: { status: 'pending', reason: null },
    },
    accessGrant: { plan: 'free', admittedAt: '2026-10-06T02:00:00.000Z', timeLimitSeconds: 1200 },
    pins: {
      taskDefinitionArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      challengeImageDigest: `sha256:${'a'.repeat(64)}`,
      monitorImageDigest: `sha256:${'b'.repeat(64)}`,
    },
    launchArguments: {
      cluster,
      taskDefinition: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      clientToken: sessionId,
      startedBy: sessionId,
      count: 1,
      enableExecuteCommand: false,
      launchType: 'FARGATE',
      platformVersion: '1.4.0',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-0123456789abcdef0'],
          securityGroups: ['sg-0123456789abcdef0'],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'monitor',
            environment: [{ name: 'OPSREPLAY_SESSION_ID', value: sessionId }],
            environmentFiles: [{ type: 's3', value: `arn:aws:s3:::test-secrets/sessions/${sessionId}.env` }],
          },
        ],
      },
      tags: [{ key: 'opsreplay:session-id', value: sessionId }],
    },
    monitorSecret,
    monitorCertificate: null,
    launchFailure: null,
    provisioningDeadline: '2026-10-06T02:03:00.000Z',
    launchRecoveryDeadline: '2026-10-06T02:08:00.000Z',
    scheduleName: `session-${sessionId}`,
    taskArn: null,
    taskAddress: null,
    provisioningCleanup: { status: 'pending', completedAt: null },
  };
}

test('the Scheduler adapter creates distinct timeout and recovery callbacks before launch', async () => {
  const schedules = new Map<string, CreateScheduleCommand['input']>();
  let created: CreateScheduleCommand['input'] | undefined;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetScheduleCommand) {
        const existing = schedules.get(command.input.Name!);
        if (!existing) throw new ResourceNotFoundException({ $metadata: {}, Message: 'missing', message: 'missing' });
        return { ...existing, State: 'ENABLED' };
      }
      assert.ok(command instanceof CreateScheduleCommand);
      created = command.input;
      schedules.set(created.Name!, created);
      return {};
    },
  } as unknown as SchedulerClient;
  const schedule = new ProvisioningSchedule(client, {
    groupName: 'test-sessions',
    expiryFunctionArn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:test-expiry',
    targetRoleArn: 'arn:aws:iam::123456789012:role/test-scheduler',
  });
  const record = session();
  record.provisioningDeadline = '2026-10-06T02:03:00.250Z';
  record.launchRecoveryDeadline = '2026-10-06T02:08:00.250Z';
  await schedule.ensure(record, new Date('2026-10-06T02:00:10.000Z'));
  await schedule.ensure(record, new Date('2026-10-06T02:00:20.000Z'));
  assert.equal(schedules.size, 2);
  assert.equal(schedules.get(record.scheduleName)?.ScheduleExpression, 'at(2026-10-06T02:03:01)');
  assert.equal(schedules.get(`${record.scheduleName}-recovery`)?.ScheduleExpression, 'at(2026-10-06T02:08:01)');
  assert.equal(new Set([...schedules.values()].map((item) => item.ClientToken)).size, 2);
  assert.equal(created?.ScheduleExpressionTimezone, 'UTC');
  assert.equal(created?.ActionAfterCompletion, 'DELETE');
  assert.equal(created?.FlexibleTimeWindow?.Mode, 'OFF');
  assert.equal(created?.Target?.Input, JSON.stringify({ sessionId }));
  assert.deepEqual(created?.Target?.RetryPolicy, { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 20 });
});

test('the Scheduler adapter rejects an existing schedule with another target', async () => {
  const record = session();
  const client = {
    send: async (command: unknown) => {
      assert.ok(command instanceof GetScheduleCommand);
      return {
        GroupName: 'test-sessions',
        State: 'ENABLED',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        ScheduleExpression: 'at(2026-10-06T02:03:00)',
        ScheduleExpressionTimezone: 'UTC',
        Target: {
          Arn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:wrong-target',
          RoleArn: 'arn:aws:iam::123456789012:role/test-scheduler',
          Input: JSON.stringify({ sessionId }),
          RetryPolicy: { MaximumEventAgeInSeconds: 900, MaximumRetryAttempts: 20 },
        },
      };
    },
  } as unknown as SchedulerClient;
  const schedule = new ProvisioningSchedule(client, {
    groupName: 'test-sessions',
    expiryFunctionArn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:test-expiry',
    targetRoleArn: 'arn:aws:iam::123456789012:role/test-scheduler',
  });
  await assert.rejects(schedule.ensure(record, new Date('2026-10-06T02:00:10.000Z')), /does not match/);
});

test('the Scheduler adapter recovers when another invocation created the same schedule', async () => {
  const schedules = new Map<string, CreateScheduleCommand['input']>();
  let created: CreateScheduleCommand['input'] | undefined;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetScheduleCommand) {
        const existing = schedules.get(command.input.Name!);
        if (!existing) throw new ResourceNotFoundException({ $metadata: {}, Message: 'missing', message: 'missing' });
        return { ...existing, State: 'ENABLED' };
      }
      assert.ok(command instanceof CreateScheduleCommand);
      created = command.input;
      schedules.set(created.Name!, created);
      throw new ConflictException({ $metadata: {}, Message: 'exists', message: 'exists' });
    },
  } as unknown as SchedulerClient;
  const schedule = new ProvisioningSchedule(client, {
    groupName: 'test-sessions',
    expiryFunctionArn: 'arn:aws:lambda:ap-southeast-1:123456789012:function:test-expiry',
    targetRoleArn: 'arn:aws:iam::123456789012:role/test-scheduler',
  });
  await schedule.ensure(session(), new Date('2026-10-06T02:09:10.250Z'));
  assert.equal(created?.ScheduleExpression, 'at(2026-10-06T02:10:11)');
});

test('the Fargate adapter sends the persisted RunTask arguments unchanged', async () => {
  const record = session();
  let sent: RunTaskCommand['input'] | undefined;
  const client = {
    send: async (command: unknown) => {
      assert.ok(command instanceof RunTaskCommand);
      sent = command.input;
      return { tasks: [{ taskArn }] };
    },
  } as unknown as ECSClient;
  const environment = new FargateEnvironment(client);
  assert.equal(await environment.launch(record.launchArguments), taskArn);
  assert.deepEqual(sent, record.launchArguments);
});

test('the Fargate adapter distinguishes a confirmed rejection from an uncertain result', async () => {
  const record = session();
  const rejected = new FargateEnvironment({
    send: async () => ({ failures: [{ reason: capacityMessage }] }),
  } as unknown as ECSClient);
  await assert.rejects(rejected.launch(record.launchArguments), LaunchRejectedError);
  const uncertain = new FargateEnvironment({ send: async () => ({}) } as unknown as ECSClient);
  await assert.rejects(uncertain.launch(record.launchArguments), /exactly one task/);
});

test('the Fargate adapter finds only matching active tasks and bounds cluster scans', async () => {
  let lists = 0;
  const otherArn = taskArn.replace(/a/g, 'b');
  const client = {
    send: async (command: unknown) => {
      if (command instanceof ListTasksCommand) {
        lists++;
        assert.deepEqual(command.input, { cluster, startedBy: sessionId, maxResults: 100 });
        return { taskArns: [taskArn, otherArn] };
      }
      assert.ok(command instanceof DescribeTasksCommand);
      return {
        tasks: [
          { taskArn, startedBy: sessionId, lastStatus: 'PENDING' },
          { taskArn: otherArn, startedBy: randomUUID(), lastStatus: 'RUNNING' },
        ],
      };
    },
  } as unknown as ECSClient;
  const environment = new FargateEnvironment(client);
  assert.deepEqual(await environment.findActive(cluster, sessionId), [{ taskArn, lastStatus: 'PENDING' }]);
  assert.equal(lists, 1);

  const overflowing = new FargateEnvironment({
    send: async (command: unknown) => {
      assert.ok(command instanceof ListTasksCommand);
      return { taskArns: [], nextToken: 'more' };
    },
  } as unknown as ECSClient);
  await assert.rejects(overflowing.findActive(cluster, sessionId), /safety bound/);
});

test('the Fargate adapter describes and stops the exact saved task', async () => {
  const commands: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof DescribeTasksCommand) return { tasks: [{ taskArn, lastStatus: 'STOPPED' }] };
      assert.ok(command instanceof StopTaskCommand);
      return {};
    },
  } as unknown as ECSClient;
  const environment = new FargateEnvironment(client);
  assert.deepEqual(await environment.describe(cluster, taskArn), { taskArn, lastStatus: 'STOPPED' });
  await environment.stop(cluster, taskArn, 'expired');
  assert.equal(commands.length, 2);
  assert.deepEqual((commands[1] as StopTaskCommand).input, { cluster, task: taskArn, reason: 'expired' });
});

test('runtime configuration rejects missing or malformed deployment values', () => {
  const environment = {
    ECS_CLUSTER_ARN: cluster,
    ECS_SUBNET_IDS: 'subnet-0123456789abcdef0,subnet-11111111111111111',
    ECS_SECURITY_GROUP_IDS: 'sg-0123456789abcdef0',
    ECS_PLATFORM_VERSION: '1.4.0',
    MONITOR_CONTAINER_NAME: 'monitor',
    MONITOR_SECRET_BUCKET_ARN: 'arn:aws:s3:::test-secrets',
    SCHEDULER_GROUP_NAME: 'test-sessions',
    PROVISIONING_EXPIRY_FUNCTION_ARN: 'arn:aws:lambda:ap-southeast-1:123456789012:function:test-expiry',
    SCHEDULER_TARGET_ROLE_ARN: 'arn:aws:iam::123456789012:role/test-scheduler',
  };
  assert.deepEqual(loadLaunchConfiguration(environment), {
    clusterArn: cluster,
    subnetIds: ['subnet-0123456789abcdef0', 'subnet-11111111111111111'],
    securityGroupIds: ['sg-0123456789abcdef0'],
    platformVersion: '1.4.0',
    monitorContainerName: 'monitor',
    secretBucketArn: 'arn:aws:s3:::test-secrets',
  });
  assert.deepEqual(loadScheduleConfiguration(environment), {
    groupName: 'test-sessions',
    expiryFunctionArn: environment.PROVISIONING_EXPIRY_FUNCTION_ARN,
    targetRoleArn: environment.SCHEDULER_TARGET_ROLE_ARN,
  });
  assert.throws(() => loadLaunchConfiguration({ ...environment, ECS_SUBNET_IDS: 'public-subnet' }), /invalid/);
  assert.throws(() => loadScheduleConfiguration({ ...environment, SCHEDULER_TARGET_ROLE_ARN: '*' }), /invalid/);
});

test('the expiry handler validates events and preserves time for retries', async () => {
  const calls: { sessionId: string; signal: AbortSignal | undefined }[] = [];
  const logs: unknown[] = [];
  const handler = createExpiryHandler({
    expire: async (id, signal) => {
      calls.push({ sessionId: id, signal });
      return 'cleaned';
    },
    log: (entry) => logs.push(entry),
  });
  await handler({ sessionId }, { getRemainingTimeInMillis: () => 20_000 });
  assert.equal(calls[0]?.sessionId, sessionId);
  assert.equal(calls[0]?.signal?.aborted, false);
  assert.equal((logs[0] as { result: string }).result, 'cleaned');
  await assert.rejects(handler({ sessionId: 'invalid' }, { getRemainingTimeInMillis: () => 20_000 }), /Invalid/);
});

test('the bundled expiry Lambda rejects malformed events before AWS calls', async () => {
  const previous = process.env.SESSION_TABLE_NAME;
  try {
    process.env.SESSION_TABLE_NAME = 'test-unused';
    const bundled = createRequire(import.meta.url)('../../../dist/expire-provisioning/index.cjs');
    await assert.rejects(
      bundled.handler({ sessionId: 'invalid' }, { getRemainingTimeInMillis: () => 20_000 }),
      /Invalid/,
    );
  } finally {
    if (previous === undefined) delete process.env.SESSION_TABLE_NAME;
    else process.env.SESSION_TABLE_NAME = previous;
  }
});

for (const reasons of [
  ['RESOURCE:CPU'],
  ['RESOURCE:MEMORY', 'RESOURCE:ENI'],
  ['MISSING'],
  ['INACTIVE'],
  ['RESOURCE:CPU', 'MISSING'],
  ['private detail here'],
]) {
  test(`RunTask failure classification: ${reasons.join(', ')}`, async () => {
    const environment = new FargateEnvironment({
      send: async () => ({ failures: reasons.map((reason) => ({ reason })) }),
    } as unknown as ECSClient);
    await assert.rejects(environment.launch(session().launchArguments), (error: unknown) => {
      assert.ok(error instanceof LaunchRejectedError);
      assert.equal(
        error.failure.kind,
        reasons.every((reason) => reason.startsWith('RESOURCE:')) ? 'capacity' : 'configuration',
      );
      assert.equal(JSON.stringify(error).includes('private detail here'), false);
      return true;
    });
  });
}

test('monitor certificate is bounded, self-signed, valid for the session, and matches its private key', async () => {
  const record = session();
  record.view.createdAt = '2026-10-06T02:00:00.250Z';
  record.launchRecoveryDeadline = '2026-10-06T02:08:00.250Z';
  const pair = await createMonitorCertificate(record);
  const certificate = new X509Certificate(pair.certificate);
  assert.equal(certificate.ca, false);
  assert.equal(certificate.subject, certificate.issuer);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(pair.privateKey)), true);
  assert.equal(certificate.publicKey.asymmetricKeyType, 'ec');
  assert.equal(certificate.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1');
  assert.ok(certificate.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  assert.ok(Date.parse(certificate.validFrom) <= Date.parse(record.view.createdAt));
  assert.ok(
    Date.parse(certificate.validTo) >=
      Date.parse(record.launchRecoveryDeadline) +
        record.accessGrant.timeLimitSeconds * 1000 +
        recordingWorkTiming.postSessionWindowMs,
  );
  assert.ok(Buffer.byteLength(pair.certificate) <= 16_384);
  assert.ok(Buffer.byteLength(pair.privateKey) <= 16_384);
});

test('monitor bootstrap upload is encrypted, immutable, validated, and reusable', async () => {
  const record = session();
  const signal = AbortSignal.timeout(1000);
  let uploads = 0;
  let reads = 0;
  let stored: string | undefined;
  let storedTags: Tag[] | undefined;
  const bootstrap = new MonitorBootstrapFile({
    send: async (command: unknown, options: unknown) => {
      assert.deepEqual(options, { abortSignal: signal });
      if (command instanceof GetObjectTaggingCommand) {
        reads++;
        assert.deepEqual(command.input, {
          Bucket: 'test-secrets',
          Key: `sessions/${sessionId}.env`,
        });
        assert.ok(storedTags);
        return { TagSet: storedTags };
      }
      assert.ok(command instanceof PutObjectCommand);
      uploads++;
      assert.equal(command.input.Bucket, 'test-secrets');
      assert.equal(command.input.Key, `sessions/${sessionId}.env`);
      assert.equal(command.input.ContentType, 'text/plain; charset=utf-8');
      assert.equal(command.input.ServerSideEncryption, 'AES256');
      assert.equal(command.input.IfNoneMatch, '*');
      if (typeof command.input.Body !== 'string') throw new Error('Expected a text bootstrap file');
      if (stored)
        throw new S3ServiceException({
          name: 'PreconditionFailed',
          $fault: 'client',
          $metadata: { httpStatusCode: 412 },
        });
      stored = command.input.Body;
      storedTags = parseTagging(command.input.Tagging);
      return {};
    },
  } as unknown as S3Client);
  const certificate = await bootstrap.ensure(record, signal);
  assert.ok(stored?.startsWith(`OPSREPLAY_MONITOR_SECRET=${record.monitorSecret}\n`));
  assert.ok(stored?.includes('OPSREPLAY_MONITOR_TLS_CERT_B64='));
  assert.ok(stored?.includes('OPSREPLAY_MONITOR_TLS_KEY_B64='));
  assert.deepEqual(storedTags, certificateTagSet(certificate));
  assert.equal(JSON.stringify(storedTags).includes(record.monitorSecret), false);
  assert.equal(await bootstrap.ensure(record, signal), certificate);
  record.monitorCertificate = certificate;
  assert.equal(await bootstrap.ensure(record, signal), certificate);
  assert.equal(uploads, 2);
  assert.equal(reads, 2);
  assert.equal(JSON.stringify(record.launchArguments).includes(record.monitorSecret), false);
  record.launchArguments.overrides.containerOverrides[0].environmentFiles[0].value = `arn:aws:s3:::test-secrets/sessions/${randomUUID()}.env`;
  await assert.rejects(bootstrap.ensure(record), /Invalid monitor bootstrap file/);
  assert.equal(uploads, 2);
});

test('monitor bootstrap upload does not hide definitive storage failures', async () => {
  const bootstrap = new MonitorBootstrapFile({
    send: async () => {
      throw new S3ServiceException({ name: 'AccessDenied', $fault: 'client', $metadata: { httpStatusCode: 403 } });
    },
  } as unknown as S3Client);
  await assert.rejects(bootstrap.ensure(session()), { name: 'AccessDenied' });
});

test('the documented Fargate capacity message normalizes before classification and logging', async () => {
  for (const message of [capacityMessage, `${capacityMessage}.`, 'Capacity is unavailable at this time.']) {
    const environment = new FargateEnvironment({
      send: async () => ({ failures: [{ reason: message }] }),
    } as unknown as ECSClient);
    await assert.rejects(environment.launch(session().launchArguments), (error: unknown) => {
      assert.ok(error instanceof LaunchRejectedError);
      assert.deepEqual(error.failure, { kind: 'capacity', reasons: ['CAPACITY'] });
      assert.equal(JSON.stringify(error).includes(message), false);
      return true;
    });
  }
  const environment = new FargateEnvironment({
    send: async () => ({ failures: [{ reason: capacityMessage }, { reason: 'MISSING' }] }),
  } as unknown as ECSClient);
  await assert.rejects(environment.launch(session().launchArguments), (error: unknown) => {
    assert.ok(error instanceof LaunchRejectedError);
    assert.deepEqual(error.failure, { kind: 'configuration', reasons: ['CAPACITY', 'MISSING'] });
    return true;
  });
});

test('an uncertain bootstrap upload reads and validates the object that actually won', async () => {
  const record = session();
  const winner = await createMonitorCertificate(record);
  let writes = 0;
  let reads = 0;
  const bootstrap = new MonitorBootstrapFile({
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        writes++;
        throw new Error('Upload response lost');
      }
      assert.ok(command instanceof GetObjectTaggingCommand);
      reads++;
      return { TagSet: certificateTagSet(winner.certificate) };
    },
  } as unknown as S3Client);
  assert.equal(await bootstrap.ensure(record), winner.certificate);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
});

for (const outcome of ['uploaded', 'already_exists'] as const) {
  test(`S3 conditional conflict is retried once and then ${outcome}`, async () => {
    const record = session();
    const winner = await createMonitorCertificate(record);
    const inputs: PutObjectCommand['input'][] = [];
    const signal = AbortSignal.timeout(1000);
    const bootstrap = new MonitorBootstrapFile({
      send: async (command: unknown, options: unknown) => {
        assert.deepEqual(options, { abortSignal: signal });
        if (command instanceof GetObjectTaggingCommand) {
          return { TagSet: certificateTagSet(winner.certificate) };
        }
        assert.ok(command instanceof PutObjectCommand);
        inputs.push(command.input);
        if (inputs.length === 1)
          throw new S3ServiceException({
            name: 'ConditionalRequestConflict',
            $fault: 'client',
            $metadata: { httpStatusCode: 409 },
          });
        if (outcome === 'already_exists')
          throw new S3ServiceException({
            name: 'PreconditionFailed',
            $fault: 'client',
            $metadata: { httpStatusCode: 412 },
          });
        return {};
      },
    } as unknown as S3Client);
    const certificate = await bootstrap.ensure(record, signal);
    if (outcome === 'already_exists') assert.equal(certificate, winner.certificate);
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs[0], inputs[1]);
  });
}

test('repeated S3 conflicts fail when no bootstrap object exists', async () => {
  let calls = 0;
  const bootstrap = new MonitorBootstrapFile({
    send: async (command: unknown) => {
      if (command instanceof GetObjectTaggingCommand) {
        throw new S3ServiceException({ name: 'NoSuchKey', $fault: 'client', $metadata: { httpStatusCode: 404 } });
      }
      calls++;
      throw new S3ServiceException({
        name: 'ConditionalRequestConflict',
        $fault: 'client',
        $metadata: { httpStatusCode: 409 },
      });
    },
  } as unknown as S3Client);
  await assert.rejects(bootstrap.ensure(session()), { name: 'ConditionalRequestConflict' });
  assert.equal(calls, 2);
});

test('monitor bootstrap recovery rejects invalid certificate tags', async () => {
  const record = session();
  record.monitorCertificate = (await createMonitorCertificate(record)).certificate;
  const bootstrap = new MonitorBootstrapFile({
    send: async (command: unknown) => {
      assert.ok(command instanceof GetObjectTaggingCommand);
      return {
        TagSet: [
          { Key: 'opsreplay-certificate-parts', Value: '2' },
          { Key: 'opsreplay-certificate-0', Value: 'not-a-certificate' },
        ],
      };
    },
  } as unknown as S3Client);
  await assert.rejects(bootstrap.ensure(record), /Invalid stored monitor certificate tags/);
});

test('the S3 conflict retry obeys the invocation deadline', async () => {
  let calls = 0;
  const controller = new AbortController();
  const bootstrap = new MonitorBootstrapFile({
    send: async () => {
      calls++;
      controller.abort();
      throw new S3ServiceException({
        name: 'ConditionalRequestConflict',
        $fault: 'client',
        $metadata: { httpStatusCode: 409 },
      });
    },
  } as unknown as S3Client);
  await assert.rejects(bootstrap.ensure(session(), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});
