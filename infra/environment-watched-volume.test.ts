import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { Template } from 'aws-cdk-lib/assertions';
import { environmentWatchedVolume } from './environment-watched-volume.js';

test('publication layout uses one per-task volume, writable only by the Challenge', () => {
  const layout = environmentWatchedVolume();
  const stack = new Stack(new App(), 'WatchedVolumeTest');
  new CfnTaskDefinition(stack, 'Environment', {
    family: 'opsreplay-test-only',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '1024',
    memory: '2048',
    volumes: [layout.volume],
    containerDefinitions: [
      {
        name: 'challenge',
        image: 'test-challenge',
        essential: true,
        mountPoints: [layout.challenge.mountPoint],
        environment: [layout.challenge.environment],
      },
      {
        name: 'monitor',
        image: 'test-monitor',
        essential: true,
        user: '1000',
        readonlyRootFilesystem: true,
        mountPoints: [layout.monitor.mountPoint],
      },
    ],
  });
  Template.fromStack(stack).hasResourceProperties('AWS::ECS::TaskDefinition', {
    Volumes: [{ Name: 'watched-files' }],
    ContainerDefinitions: [
      {
        Name: 'challenge',
        Image: 'test-challenge',
        Essential: true,
        Environment: [{ Name: 'OPSREPLAY_WATCHED_FILES', Value: '1' }],
        MountPoints: [{ SourceVolume: 'watched-files', ContainerPath: '/opsreplay/watched', ReadOnly: false }],
      },
      {
        Name: 'monitor',
        Image: 'test-monitor',
        Essential: true,
        User: '1000',
        ReadonlyRootFilesystem: true,
        MountPoints: [{ SourceVolume: 'watched-files', ContainerPath: '/opsreplay/watched', ReadOnly: true }],
      },
    ],
  });
  const resources = Template.fromStack(stack).toJSON().Resources;
  const task = Object.values(resources)[0] as { Properties: Record<string, unknown> };
  assert.equal(task.Properties.TaskRoleArn, undefined);
  assert.equal(JSON.stringify(layout).includes('Secret'), false);
  assert.notEqual(environmentWatchedVolume().volume, layout.volume);
});
