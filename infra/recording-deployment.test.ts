import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

test('the recording path is private, bounded, least-privilege, and disabled by default', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-recording-cdk-'));
  try {
    const app = new App({ outdir: directory });
    const stack = new SessionStartStack(app, 'TestRecording');
    const template = Template.fromStack(stack);
    const rendered = template.toJSON() as {
      Parameters: Record<string, Record<string, unknown>>;
      Conditions: Record<string, unknown>;
      Resources: Record<string, Resource>;
    };

    assert.deepEqual(rendered.Parameters.EnableRecordingPath, {
      Type: 'String',
      Default: 'false',
      AllowedValues: ['false', 'true'],
    });
    assert.ok(rendered.Conditions.RecordingPathEnabled);
    assert.equal(rendered.Parameters.GatewayDesiredCount?.Default, 1);
    assert.equal(rendered.Parameters.GatewayMaximumConcurrentRecordings?.Default, 16);
    assert.equal(rendered.Parameters.GatewayMaximumConcurrentRecordings?.MaxValue, 64);
    assert.deepEqual(rendered.Parameters.EnvironmentMonitorSecurityGroupId, {
      Type: 'AWS::EC2::SecurityGroup::Id',
    });

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: [
        {
          IndexName: 'unfinished-work',
          KeySchema: [
            { AttributeName: 'WorkPK', KeyType: 'HASH' },
            { AttributeName: 'WorkSK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
    });

    const buckets = Object.values(rendered.Resources).filter((resource) => resource.Type === 'AWS::S3::Bucket');
    assert.equal(buckets.length, 2);
    const recordingBucket = buckets.find((resource) => resource.Properties?.LifecycleConfiguration === undefined);
    assert.ok(recordingBucket);
    assert.equal(recordingBucket.DeletionPolicy, 'Retain');
    assert.equal(recordingBucket.UpdateReplacePolicy, 'Retain');
    assert.deepEqual(recordingBucket.Properties?.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.deepEqual(recordingBucket.Properties?.BucketEncryption, {
      ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Timeout: 10,
      MemorySize: 256,
      Environment: { Variables: { SESSION_TABLE_NAME: Match.anyValue() } },
      ReservedConcurrentExecutions: { 'Fn::If': ['RecordingPathEnabled', 4, 0] },
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 120,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1_209_600,
      SqsManagedSseEnabled: true,
      VisibilityTimeout: 30,
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      State: { 'Fn::If': ['RecordingPathEnabled', 'ENABLED', 'DISABLED'] },
      EventPattern: {
        source: ['aws.ecs'],
        'detail-type': ['ECS Task State Change'],
        detail: { clusterArn: [{ Ref: 'EnvironmentClusterArn' }], lastStatus: ['RUNNING'] },
      },
      Targets: [
        Match.objectLike({
          DeadLetterConfig: { Arn: Match.anyValue() },
          RetryPolicy: { MaximumEventAgeInSeconds: 120, MaximumRetryAttempts: 2 },
        }),
      ],
    });
    template.resourceCountIs('AWS::Lambda::Permission', 1);

    template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'OpsReplay gateway recording tasks. No inbound listener in this increment.',
      SecurityGroupEgress: Match.arrayWith([
        Match.objectLike({
          IpProtocol: 'tcp',
          FromPort: 9443,
          ToPort: 9443,
          DestinationSecurityGroupId: { Ref: 'EnvironmentMonitorSecurityGroupId' },
        }),
      ]),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      GroupId: { Ref: 'EnvironmentMonitorSecurityGroupId' },
      SourceSecurityGroupId: Match.anyValue(),
      IpProtocol: 'tcp',
      FromPort: 9443,
      ToPort: 9443,
    });

    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '1024',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'gateway-recording',
          Image: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
          Essential: true,
          ReadonlyRootFilesystem: true,
          User: 'node',
          StopTimeout: 30,
          LinuxParameters: { Capabilities: { Drop: ['ALL'] }, InitProcessEnabled: true },
          Environment: [
            { Name: 'SESSION_TABLE_NAME', Value: Match.anyValue() },
            { Name: 'RECORDING_BUCKET_NAME', Value: Match.anyValue() },
            { Name: 'MAXIMUM_CONCURRENT_RECORDINGS', Value: { Ref: 'GatewayMaximumConcurrentRecordings' } },
            { Name: 'MONITOR_PORT', Value: '9443' },
          ],
        }),
      ],
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: { 'Fn::If': ['RecordingPathEnabled', { Ref: 'GatewayDesiredCount' }, 0] },
      LaunchType: 'FARGATE',
      PlatformVersion: '1.4.0',
      EnableExecuteCommand: false,
      DeploymentConfiguration: {
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MaximumPercent: 200,
        MinimumHealthyPercent: 100,
      },
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'DISABLED',
          SecurityGroups: [Match.anyValue()],
          Subnets: { Ref: 'EnvironmentSubnetIds' },
        },
      },
    });

    const roles = Object.values(rendered.Resources).filter((resource) => resource.Type === 'AWS::IAM::Role');
    assert.equal(roles.length, 6);
    for (const role of roles) assert.equal(role.Properties?.ManagedPolicyArns, undefined);

    const policies = Object.values(rendered.Resources).filter((resource) => resource.Type === 'AWS::IAM::Policy');
    const statements = policies.flatMap((policy) => {
      const document = policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] };
      return document.Statement;
    });
    assert.ok(
      statements.some(
        (statement) =>
          JSON.stringify(statement.Action) === JSON.stringify(['dynamodb:GetItem', 'dynamodb:UpdateItem']) &&
          JSON.stringify(statement.Condition) ===
            JSON.stringify({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } }),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          JSON.stringify(statement.Action) ===
            JSON.stringify([
              'dynamodb:ConditionCheckItem',
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:UpdateItem',
            ]) &&
          JSON.stringify(statement.Condition) ===
            JSON.stringify({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } }),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.Action === 'dynamodb:Query' && JSON.stringify(statement.Resource).includes('unfinished-work'),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.Action === 's3:PutObject' && JSON.stringify(statement.Resource).includes('/sessions/*'),
      ),
    );
    assert.equal(
      statements.some(
        (statement) =>
          ['s3:GetObject', 's3:ListBucket', 's3:DeleteObject'].includes(statement.Action as string) &&
          JSON.stringify(statement.Resource).includes('Recordings'),
      ),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
