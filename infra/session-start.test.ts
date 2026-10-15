import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

test('the stack preserves separate inactive lifecycle, session-status, and terminal-ticket actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-cdk-'));
  try {
    const app = new App({ outdir: directory });
    const stack = new SessionStartStack(app, 'TestStart');
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 14);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::S3::Bucket', 0);
    template.resourceCountIs('AWS::S3::BucketPolicy', 0);
    template.resourceCountIs('AWS::Cognito::UserPool', 0);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      ReservedConcurrentExecutions: 0,
      Timeout: 20,
      MemorySize: 256,
    });
    template.resourceCountIs('AWS::Lambda::EventInvokeConfig', 4);
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 900,
    });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
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
    const resources = Object.values(template.toJSON().Resources) as {
      Type: string;
      Properties?: Record<string, unknown>;
    }[];
    const allowed = new Set([
      'AWS::Lambda::Function',
      'AWS::Lambda::EventSourceMapping',
      'AWS::ApiGateway::Authorizer',
      'AWS::ApiGateway::Deployment',
      'AWS::ApiGateway::GatewayResponse',
      'AWS::ApiGateway::Method',
      'AWS::ApiGateway::Resource',
      'AWS::ApiGateway::RestApi',
      'AWS::ApiGateway::Stage',
      'AWS::Cognito::UserPoolClient',
      'AWS::Cognito::UserPoolDomain',
      'AWS::IAM::Role',
      'AWS::IAM::Policy',
      'AWS::Logs::LogGroup',
      'AWS::Scheduler::ScheduleGroup',
      'AWS::Lambda::EventInvokeConfig',
      'AWS::CloudWatch::Alarm',
      'AWS::EC2::SecurityGroup',
      'AWS::EC2::SecurityGroupEgress',
      'AWS::EC2::SecurityGroupIngress',
      'AWS::SQS::Queue',
      'AWS::SQS::QueuePolicy',
      'AWS::Events::Rule',
      'AWS::Lambda::Permission',
      'AWS::ECS::TaskDefinition',
      'AWS::ECS::Service',
      'AWS::ElasticLoadBalancingV2::Listener',
      'AWS::ElasticLoadBalancingV2::ListenerRule',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'AWS::CloudFront::Distribution',
      'AWS::CloudFront::VpcOrigin',
      'AWS::CloudFront::OriginRequestPolicy',
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
      'dynamodb:BatchGetItem',
      'dynamodb:ConditionCheckItem',
      'dynamodb:DeleteItem',
      'dynamodb:DescribeStream',
      'dynamodb:GetItem',
      'dynamodb:GetRecords',
      'dynamodb:GetShardIterator',
      'dynamodb:ListStreams',
      'dynamodb:PutItem',
      'dynamodb:Query',
      'dynamodb:TransactGetItems',
      'dynamodb:UpdateItem',
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:GetAuthorizationToken',
      'ecr:GetDownloadUrlForLayer',
      'ecs:DescribeTasks',
      'ecs:ListTasks',
      'ecs:RunTask',
      'ecs:StopTask',
      'ecs:TagResource',
      'iam:PassRole',
      'lambda:InvokeFunction',
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      's3:GetObject',
      's3:GetObjectTagging',
      's3:PutObject',
      's3:PutObjectTagging',
      'scheduler:CreateSchedule',
      'scheduler:DeleteSchedule',
      'scheduler:GetSchedule',
      'scheduler:UpdateSchedule',
      'sqs:GetQueueAttributes',
      'sqs:GetQueueUrl',
      'sqs:SendMessage',
    ]);
    assert.deepEqual([...wildcardActions].sort(), ['ecr:GetAuthorizationToken', 'ecs:ListTasks']);
    for (const fn of resources.filter((item) => item.Type === 'AWS::Lambda::Function')) {
      assert.equal(fn.Properties?.VpcConfig, undefined);
    }
    assert.equal(
      resources.filter(
        (item) => item.Type === 'AWS::Lambda::Function' && item.Properties?.ReservedConcurrentExecutions === 0,
      ).length,
      1,
    );
    for (const fn of resources.filter(
      (item) =>
        item.Type === 'AWS::Lambda::Function' && typeof item.Properties?.ReservedConcurrentExecutions === 'object',
    )) {
      const concurrency = fn.Properties?.ReservedConcurrentExecutions;
      assert.ok(concurrency && typeof concurrency === 'object');
      assert.equal((concurrency as { 'Fn::If': unknown[] })['Fn::If'].at(-1), 0);
    }
    for (const role of resources.filter((item) => item.Type === 'AWS::IAM::Role')) {
      assert.equal(role.Properties?.ManagedPolicyArns, undefined);
    }
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          ECS_PLATFORM_VERSION: '1.4.0',
          MONITOR_CONTAINER_NAME: 'monitor',
          SESSION_TABLE_NAME: {
            'Fn::Select': [
              1,
              {
                'Fn::Split': [
                  '/',
                  {
                    'Fn::Select': [
                      5,
                      {
                        'Fn::Split': [
                          ':',
                          { 'Fn::Select': [0, { 'Fn::Split': ['/stream/', { Ref: 'SessionTableStreamArn' }] }] },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
