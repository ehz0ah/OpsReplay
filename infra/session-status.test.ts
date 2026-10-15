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
  Condition?: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
};

test('session status shares the Cognito API but has a separate bounded read-only action', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-status-cdk-'));
  try {
    const app = new App({ outdir: directory });
    const template = Template.fromStack(new SessionStartStack(app, 'TestStatus'));
    const rendered = template.toJSON();
    const resources = rendered.Resources as Record<string, Resource>;
    const get = (type: string) => Object.entries(resources).filter(([, resource]) => resource.Type === type);
    const fn = get('AWS::Lambda::Function').find(([id]) => id.startsWith('GetSession'));
    const authorizer = get('AWS::ApiGateway::Authorizer')[0];
    assert.ok(fn && authorizer);
    const [functionId, functionResource] = fn;
    assert.equal(functionResource.Properties?.VpcConfig, undefined);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Timeout: 10,
      MemorySize: 256,
      Environment: {
        Variables: Match.objectLike({
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
        }),
      },
      ReservedConcurrentExecutions: {
        'Fn::If': ['GatewayPathEnabled', { Ref: 'SessionStatusBurstLimit' }, 0],
      },
    });
    for (const [parameter, defaultValue] of [
      ['SessionStatusBurstLimit', 16],
      ['SessionStatusRateLimit', 8],
    ] as const) {
      assert.deepEqual(rendered.Parameters[parameter], {
        Type: 'Number',
        Default: defaultValue,
        MinValue: 1,
        MaxValue: 256,
        Description:
          parameter === 'SessionStatusBurstLimit'
            ? 'Session-status API burst and separate Lambda concurrency limit.'
            : 'Sustained session-status requests per second.',
      });
    }
    assert.equal(rendered.Parameters.EnableGatewayPath.Default, 'false');
    const role = functionResource.Properties?.Role as { 'Fn::GetAtt': [string, string] };
    const roleId = role['Fn::GetAtt'][0];
    assert.ok(resources[roleId]);
    assert.equal(resources[roleId].Properties?.ManagedPolicyArns, undefined);
    const policies = get('AWS::IAM::Policy').filter(([, policy]) => {
      const roles = policy.Properties?.Roles as { Ref: string }[] | undefined;
      return roles?.some((value) => value.Ref === roleId);
    });
    assert.equal(policies.length, 1);
    const policy = policies[0];
    assert.ok(policy);
    const document = policy[1].Properties?.PolicyDocument as { Statement: Record<string, unknown>[] };
    const databaseStatements = document.Statement.filter((statement) =>
      JSON.stringify(statement.Action).includes('dynamodb:'),
    );
    assert.deepEqual(databaseStatements, [
      {
        Action: 'dynamodb:GetItem',
        Effect: 'Allow',
        Resource: { 'Fn::Select': [0, { 'Fn::Split': ['/stream/', { Ref: 'SessionTableStreamArn' }] }] },
        Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      },
    ]);
    const otherActions = document.Statement.filter(
      (statement) => !JSON.stringify(statement.Action).includes('dynamodb:'),
    ).flatMap((statement) => [statement.Action].flat());
    assert.deepEqual(otherActions.sort(), ['logs:CreateLogStream', 'logs:PutLogEvents']);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
    template.resourceCountIs('AWS::ApiGateway::Method', 16);
    template.resourceCountIs('AWS::Lambda::Function', 12);

    const method = get('AWS::ApiGateway::Method').find(([, resource]) => resource.Properties?.HttpMethod === 'GET');
    assert.ok(method);
    assert.equal(method[1].Condition, 'GatewayPathEnabled');
    const sessionResource = method[1].Properties?.ResourceId as { Ref: string };
    assert.equal(resources[sessionResource.Ref]?.Properties?.PathPart, '{id}');
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'COGNITO_USER_POOLS',
      OperationName: 'getSession',
      ApiKeyRequired: false,
      AuthorizerId: { Ref: authorizer[0] },
      Integration: Match.objectLike({ Type: 'AWS_PROXY', IntegrationHttpMethod: 'POST', TimeoutInMillis: 8000 }),
    });
    assert.ok(JSON.stringify(method[1].Properties?.Integration).includes(functionId));
    const permission = get('AWS::Lambda::Permission').find(([, resource]) =>
      JSON.stringify(resource.Properties?.FunctionName).includes(functionId),
    );
    assert.ok(permission);
    assert.equal(permission[1].Condition, 'GatewayPathEnabled');
    assert.equal(permission[1].Properties?.Action, 'lambda:InvokeFunction');
    assert.equal(permission[1].Properties?.Principal, 'apigateway.amazonaws.com');
    assert.ok(JSON.stringify(permission[1].Properties?.SourceArn).includes('/*/GET/v1/sessions/*'));
    const deployment = get('AWS::ApiGateway::Deployment')[0];
    assert.ok(deployment);
    assert.equal(deployment[0], 'TerminalTicketApiDeploymentV7');
    const dependencies = [deployment[1].DependsOn].flat();
    for (const [id] of get('AWS::ApiGateway::Method')) assert.ok(dependencies.includes(id));
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.arrayWith([
        {
          HttpMethod: 'GET',
          ResourcePath: '/~1v1~1sessions~1{id}',
          CachingEnabled: false,
          DataTraceEnabled: false,
          MetricsEnabled: true,
          ThrottlingBurstLimit: { Ref: 'SessionStatusBurstLimit' },
          ThrottlingRateLimit: { Ref: 'SessionStatusRateLimit' },
        },
      ]),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
