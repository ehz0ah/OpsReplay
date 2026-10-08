import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

test('the session-start stack has separate disabled start and expiry actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-cdk-'));
  try {
    const app = new App({ outdir: directory });
    const stack = new SessionStartStack(app, 'TestStart');
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      ReservedConcurrentExecutions: 0,
      Timeout: 20,
      MemorySize: 256,
    });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: { BillingMode: 'PAY_PER_REQUEST' },
    });
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 1);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 900,
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'AsyncEventsDropped',
      Threshold: 1,
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Scheduler',
      MetricName: 'InvocationDroppedCount',
      Threshold: 1,
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: { Rules: [{ ExpirationInDays: 1, Prefix: 'sessions/', Status: 'Enabled' }] },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:GetObject',
            Principal: { AWS: { Ref: 'EnvironmentExecutionRoleArn' } },
          }),
          Match.objectLike({
            Effect: 'Allow',
            Action: 's3:GetBucketLocation',
            Principal: { AWS: { Ref: 'EnvironmentExecutionRoleArn' } },
          }),
        ]),
      },
    });
    const resources = Object.values(template.toJSON().Resources) as {
      Type: string;
      Properties?: Record<string, unknown>;
    }[];
    const allowed = new Set([
      'AWS::Lambda::Function',
      'AWS::DynamoDB::Table',
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::Logs::LogGroup',
      'AWS::Scheduler::ScheduleGroup',
      'AWS::Lambda::EventInvokeConfig',
      'AWS::CloudWatch::Alarm',
      'AWS::S3::Bucket',
      'AWS::S3::BucketPolicy',
    ]);
    for (const resource of resources) assert.ok(allowed.has(resource.Type), `Unexpected resource: ${resource.Type}`);
    const actions = new Set<string>();
    const wildcardActions = new Set<string>();
    for (const resource of resources.filter((item) => item.Type === 'AWS::IAM::Policy')) {
      const document = resource.Properties?.PolicyDocument as {
        Statement: { Action: string | string[]; Resource: unknown }[];
      };
      for (const statement of document.Statement) {
        for (const action of [statement.Action].flat()) {
          actions.add(action);
          if (statement.Resource === '*') wildcardActions.add(action);
        }
      }
    }
    assert.deepEqual([...actions].sort(), [
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'ecs:DescribeTasks',
      'ecs:ListTasks',
      'ecs:RunTask',
      'ecs:StopTask',
      'ecs:TagResource',
      'iam:PassRole',
      'lambda:InvokeFunction',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      's3:GetObjectTagging',
      's3:PutObject',
      's3:PutObjectTagging',
      'scheduler:CreateSchedule',
      'scheduler:GetSchedule',
    ]);
    assert.deepEqual([...wildcardActions], ['ecs:ListTasks']);
    for (const fn of resources.filter((item) => item.Type === 'AWS::Lambda::Function')) {
      assert.equal(fn.Properties?.VpcConfig, undefined);
      assert.equal(fn.Properties?.ReservedConcurrentExecutions, 0);
    }
    for (const role of resources.filter((item) => item.Type === 'AWS::IAM::Role')) {
      assert.equal(role.Properties?.ManagedPolicyArns, undefined);
    }
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          ECS_PLATFORM_VERSION: '1.4.0',
          MONITOR_CONTAINER_NAME: 'monitor',
          SESSION_TABLE_NAME: { Ref: 'Sessions8896A56D' },
        },
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
