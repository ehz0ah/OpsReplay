import { readFileSync } from 'node:fs';
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import type { ReleaseIdentity } from '../src/release.js';

export const referenceBuild = JSON.parse(
  readFileSync(new URL('../../../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
);
export const digest = (character: string) => `sha256:${character.repeat(64)}`;
export const referenceIdentity: ReleaseIdentity = {
  commitSha: 'a'.repeat(40),
  account: '123456789012',
  region: 'ap-southeast-1',
  challengeImageDigest: digest('1'),
  monitorImageDigest: digest('2'),
  challengeConfigDigest: digest('3'),
  monitorConfigDigest: digest('4'),
  executionRoleArn: 'arn:aws:iam::123456789012:role/opsreplay-environment',
  logGroupName: '/opsreplay/checkpoint/environment',
};
const image = (repository: string, imageDigest: string) =>
  `${referenceIdentity.account}.dkr.ecr.${referenceIdentity.region}.amazonaws.com/${repository}@${imageDigest}`;
export function referenceTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    taskDefinitionArn: `arn:aws:ecs:${referenceIdentity.region}:${referenceIdentity.account}:task-definition/opsreplay-wrong-upstream-port:42`,
    status: 'ACTIVE',
    family: 'opsreplay-wrong-upstream-port',
    networkMode: 'awsvpc',
    cpu: '1024',
    memory: '2048',
    executionRoleArn: referenceIdentity.executionRoleArn,
    requiresCompatibilities: ['FARGATE'],
    runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
    volumes: [{ name: 'watched-files' }],
    containerDefinitions: [
      {
        name: 'challenge',
        image: image(referenceBuild.environment.image.repository, referenceIdentity.challengeImageDigest),
        essential: true,
        user: '0',
        cpu: 768,
        memory: 1536,
        readonlyRootFilesystem: false,
        versionConsistency: 'enabled',
        stopTimeout: 30,
        linuxParameters: {
          initProcessEnabled: true,
          capabilities: { drop: ['NET_RAW', 'SETPCAP', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SYS_CHROOT'] },
        },
        environment: [{ name: 'OPSREPLAY_WATCHED_FILES', value: '1' }],
        mountPoints: [{ sourceVolume: 'watched-files', containerPath: '/opsreplay/watched', readOnly: false }],
        portMappings: [{ name: 'terminal', containerPort: 7681, protocol: 'tcp' }],
      },
      {
        name: 'monitor',
        image: image(referenceBuild.environment.monitorImage.repository, referenceIdentity.monitorImageDigest),
        essential: true,
        user: '1000',
        cpu: 256,
        memory: 512,
        readonlyRootFilesystem: true,
        versionConsistency: 'enabled',
        stopTimeout: 30,
        linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
        dependsOn: [{ containerName: 'challenge', condition: 'START' }],
        mountPoints: [{ sourceVolume: 'watched-files', containerPath: '/opsreplay/watched', readOnly: true }],
        portMappings: [{ name: 'monitor-control', containerPort: 9443, protocol: 'tcp' }],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': referenceIdentity.logGroupName,
            'awslogs-region': referenceIdentity.region,
            'awslogs-stream-prefix': 'monitor',
            mode: 'non-blocking',
            'max-buffer-size': '1m',
          },
        },
      },
    ],
    ...overrides,
  };
}
