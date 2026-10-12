import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ReferenceEnvironmentStack } from './reference-environment-stack.js';
import { MonitorBootstrapFile } from '../apps/api/src/session-lifecycle/aws-bootstrap.js';
import type { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { sessionRecord } from '../apps/api/test/session-fixture.js';

function synthesize(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-reference-task-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return Template.fromStack(new ReferenceEnvironmentStack(new App({ outdir: directory }), 'TestReferenceEnvironment'));
}

test('reference blueprint registers only one revision and cannot launch or publish anything', (t) => {
  const template = synthesize(t);
  const rendered = template.toJSON();
  assert.deepEqual(
    Object.values(rendered.Resources).map((resource: any) => resource.Type),
    ['AWS::ECS::TaskDefinition'],
  );
  assert.deepEqual(rendered.Outputs, {
    ReferenceTaskDefinitionArn: {
      Value: { Ref: 'ReferenceTask' },
      Description: 'Candidate revision only. Do not admit sessions until publication and the AWS checkpoint pass.',
    },
  });
  const task = rendered.Resources.ReferenceTask.Properties;
  assert.equal(task.Family, 'opsreplay-wrong-upstream-port');
  assert.equal(task.NetworkMode, 'awsvpc');
  assert.deepEqual(task.RequiresCompatibilities, ['FARGATE']);
  assert.deepEqual(task.RuntimePlatform, { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' });
  assert.deepEqual(task.ExecutionRoleArn, { Ref: 'EnvironmentExecutionRoleArn' });
  for (const forbidden of ['TaskRoleArn', 'PidMode', 'IpcMode', 'ProxyConfiguration'])
    assert.equal(task[forbidden], undefined, forbidden);
});

test('reference image parameters require immutable SHA-256 pins in the existing local repositories', (t) => {
  const rendered = synthesize(t).toJSON();
  for (const [parameter, repository, container] of [
    ['ChallengeImageDigest', 'opsreplay/challenge-wrong-upstream-port', 'challenge'],
    ['ReferenceMonitorImageDigest', 'opsreplay/monitor', 'monitor'],
  ]) {
    const definition = rendered.Parameters[parameter!];
    assert.equal(definition.Default, undefined);
    const allowed = new RegExp(`^(?:${definition.AllowedPattern})$`);
    assert.ok(allowed.test(`sha256:${'a'.repeat(64)}`));
    for (const invalid of ['', 'latest', 'sha256:short', `sha256:${'A'.repeat(64)}`, `${'a'.repeat(64)}`])
      assert.equal(allowed.test(invalid), false, invalid);
    const image = rendered.Resources.ReferenceTask.Properties.ContainerDefinitions.find(
      (value: any) => value.Name === container,
    ).Image;
    assert.deepEqual(image, {
      'Fn::Join': [
        '',
        [
          { Ref: 'AWS::AccountId' },
          '.dkr.ecr.',
          { Ref: 'AWS::Region' },
          '.',
          { Ref: 'AWS::URLSuffix' },
          `/${repository}@`,
          { Ref: parameter },
        ],
      ],
    });
  }
});

test('resource budgets match the authored task while leaving bounded CPU and memory for Monitor', (t) => {
  const manifest = JSON.parse(
    readFileSync(new URL('../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
  );
  const task = synthesize(t).toJSON().Resources.ReferenceTask.Properties;
  const [challenge, monitor] = task.ContainerDefinitions;
  assert.equal(Number(task.Cpu), manifest.environment.cpu);
  assert.equal(Number(task.Memory), manifest.environment.memoryMiB);
  assert.equal(challenge.Cpu + monitor.Cpu, Number(task.Cpu));
  assert.equal(challenge.Memory + monitor.Memory, Number(task.Memory));
  assert.ok(monitor.Cpu >= 256 && monitor.Memory >= 512);
  assert.ok(challenge.Cpu > 0 && challenge.Memory > 0);
  for (const container of task.ContainerDefinitions) {
    assert.equal(container.Essential, true);
    assert.equal(container.StopTimeout, 30);
    assert.equal(container.HealthCheck, undefined);
    assert.equal(container.RestartPolicy, undefined);
  }
});

test('Monitor files, credentials and process space stay separate from learner root', (t) => {
  const task = synthesize(t).toJSON().Resources.ReferenceTask.Properties;
  const [challenge, monitor] = task.ContainerDefinitions;
  assert.deepEqual(task.Volumes, [{ Name: 'watched-files' }]);
  assert.deepEqual(challenge.MountPoints, [
    { SourceVolume: 'watched-files', ContainerPath: '/opsreplay/watched', ReadOnly: false },
  ]);
  assert.deepEqual(monitor.MountPoints, [
    { SourceVolume: 'watched-files', ContainerPath: '/opsreplay/watched', ReadOnly: true },
  ]);
  assert.deepEqual(challenge.Environment, [{ Name: 'OPSREPLAY_WATCHED_FILES', Value: '1' }]);
  assert.equal(monitor.Environment, undefined);
  assert.equal(challenge.User, '0');
  assert.equal(challenge.ReadonlyRootFilesystem, false);
  assert.equal(monitor.User, '1000');
  assert.equal(monitor.ReadonlyRootFilesystem, true);
  assert.deepEqual(monitor.DependsOn, [{ ContainerName: 'challenge', Condition: 'START' }]);
  assert.deepEqual(monitor.LinuxParameters.Capabilities, { Drop: ['ALL'] });
  for (const capability of ['NET_RAW', 'SETPCAP', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SYS_CHROOT'])
    assert.ok(challenge.LinuxParameters.Capabilities.Drop.includes(capability));
  for (const container of task.ContainerDefinitions) {
    assert.equal(container.LinuxParameters.InitProcessEnabled, true);
    assert.equal(container.LinuxParameters.Capabilities.Add, undefined);
    for (const forbidden of ['Privileged', 'DockerSecurityOptions', 'VolumesFrom', 'Secrets', 'EnvironmentFiles'])
      assert.equal(container[forbidden], undefined, forbidden);
  }
  assert.deepEqual(challenge.PortMappings, [{ Name: 'terminal', ContainerPort: 7681, Protocol: 'tcp' }]);
  assert.deepEqual(monitor.PortMappings, [{ Name: 'monitor-control', ContainerPort: 9443, Protocol: 'tcp' }]);
  assert.equal(challenge.LogConfiguration, undefined);
  assert.equal(monitor.LogConfiguration.LogDriver, 'awslogs');
  assert.equal(monitor.LogConfiguration.Options.mode, 'non-blocking');
  assert.equal(monitor.LogConfiguration.Options['max-buffer-size'], '1m');
});

test('existing launch bootstrap targets only the defined Monitor container without plaintext overrides', async (t) => {
  const task = synthesize(t).toJSON().Resources.ReferenceTask.Properties;
  const session = sessionRecord('11111111-1111-4111-8111-111111111112');
  const overrides = session.launchArguments.overrides.containerOverrides;
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0]!.name, task.ContainerDefinitions[1].Name);
  assert.equal(JSON.stringify(session.launchArguments).includes(session.monitorSecret), false);
  let uploaded = false;
  const client = {
    send: async (command: PutObjectCommand) => {
      assert.ok(command instanceof PutObjectCommand);
      assert.equal(command.input.IfNoneMatch, '*');
      assert.equal(command.input.ServerSideEncryption, 'AES256');
      assert.equal(command.input.Key, `sessions/${session.view.id}.env`);
      assert.ok(String(command.input.Body).includes(`OPSREPLAY_MONITOR_SECRET=${session.monitorSecret}`));
      uploaded = true;
      return {};
    },
  } as unknown as S3Client;
  await new MonitorBootstrapFile(client).ensure(session);
  assert.equal(uploaded, true);
});
