import { Aws, CfnOutput, CfnParameter, Fn, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import type { Construct } from 'constructs';
import { environmentWatchedVolume } from './environment-watched-volume.js';

/** Registers a blueprint only. Publication and the existing start action own admission and launch. */
export class ReferenceEnvironmentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const executionRole = new CfnParameter(this, 'EnvironmentExecutionRoleArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+',
      description: 'Existing environment execution role, including Monitor bootstrap-file access.',
    });
    const logs = new CfnParameter(this, 'EnvironmentLogGroupName', {
      type: 'String',
      allowedPattern: '/opsreplay/[A-Za-z0-9_./-]+',
      description: 'Existing environment log group. Only Monitor process logs are sent here.',
    });
    const image = (parameter: string, repository: string, description: string) => {
      const digest = new CfnParameter(this, parameter, {
        type: 'String',
        allowedPattern: 'sha256:[a-f0-9]{64}',
        description,
      });
      return Fn.join('', [
        Aws.ACCOUNT_ID,
        '.dkr.ecr.',
        Aws.REGION,
        '.',
        Aws.URL_SUFFIX,
        '/',
        repository,
        '@',
        digest.valueAsString,
      ]);
    };
    const layout = environmentWatchedVolume();
    const task = new CfnTaskDefinition(this, 'ReferenceTask', {
      family: 'opsreplay-wrong-upstream-port',
      cpu: '1024',
      memory: '2048',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      executionRoleArn: executionRole.valueAsString,
      // No taskRoleArn or pidMode: learner root must not inherit credentials or Monitor processes.
      volumes: [layout.volume],
      containerDefinitions: [
        {
          name: 'challenge',
          image: image('ChallengeImageDigest', 'opsreplay/challenge-wrong-upstream-port', 'Tested Challenge digest.'),
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
          environment: [layout.challenge.environment],
          mountPoints: [layout.challenge.mountPoint],
          portMappings: [{ name: 'terminal', containerPort: 7681, protocol: 'tcp' }],
        },
        {
          name: 'monitor',
          image: image(
            'ReferenceMonitorImageDigest',
            'opsreplay/monitor',
            'Tested reference target digest, containing the matching private Challenge manifest; not generic runtime.',
          ),
          essential: true,
          user: '1000',
          cpu: 256,
          memory: 512,
          readonlyRootFilesystem: true,
          versionConsistency: 'enabled',
          stopTimeout: 30,
          linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
          dependsOn: [{ containerName: 'challenge', condition: 'START' }],
          mountPoints: [layout.monitor.mountPoint],
          portMappings: [{ name: 'monitor-control', containerPort: 9443, protocol: 'tcp' }],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': logs.valueAsString,
              'awslogs-region': Aws.REGION,
              'awslogs-stream-prefix': 'monitor',
              mode: 'non-blocking',
              'max-buffer-size': '1m',
            },
          },
        },
      ],
    });
    new CfnOutput(this, 'ReferenceTaskDefinitionArn', {
      value: task.ref,
      description: 'Candidate revision only. Do not admit sessions until publication and the AWS checkpoint pass.',
    });
  }
}
