import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

type Resource = { Type: string; Condition?: string; DependsOn?: string | string[]; Properties: Record<string, any> };

test('hint release is an isolated runtime-gated action with a narrow authenticated route', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-hint-release-'));
  try {
    const rendered = Template.fromStack(new SessionStartStack(new App({ outdir: directory }), 'TestHints')).toJSON();
    const resources = rendered.Resources as Record<string, Resource>;
    const entry = Object.entries(resources).find(
      ([id, resource]) => id.startsWith('ReleaseHint') && resource.Type === 'AWS::Lambda::Function',
    );
    assert.ok(entry);
    const [functionId, fn] = entry;
    assert.equal(fn.Condition, undefined);
    assert.deepEqual(fn.Properties.ReservedConcurrentExecutions, { 'Fn::If': ['GatewayPathEnabled', 4, 0] });
    assert.equal(fn.Properties.Runtime, 'nodejs22.x');
    assert.equal(fn.Properties.Handler, 'index.handler');
    assert.equal(fn.Properties.Timeout, 10);
    assert.equal(fn.Properties.MemorySize, 256);
    assert.equal(fn.Properties.VpcConfig, undefined);
    assert.match(fn.Properties.Environment.Variables.SESSION_TABLE_NAME.Ref, /^Sessions[A-F0-9]+$/);
    assert.deepEqual(fn.Properties.Environment.Variables.PUBLIC_API_ALLOWED_ORIGIN, {
      Ref: 'PublicApiAllowedOrigin',
    });

    const role = fn.Properties.Role['Fn::GetAtt'][0] as string;
    const statements = Object.values(resources)
      .filter(
        (resource) =>
          resource.Type === 'AWS::IAM::Policy' && JSON.stringify(resource.Properties.Roles).includes(`"${role}"`),
      )
      .flatMap((resource) => resource.Properties.PolicyDocument.Statement as Record<string, any>[]);
    const actions = new Set(statements.flatMap((statement) => [statement.Action].flat()));
    for (const action of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'])
      assert.ok(actions.has(action), action);
    assert.equal(
      [...actions].some(
        (action) =>
          (action.startsWith('dynamodb:') &&
            !['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'].includes(
              action,
            )) ||
          action.startsWith('lambda:') ||
          action.startsWith('ecs:') ||
          action.startsWith('s3:'),
      ),
      false,
    );
    const leadingKeys = statements
      .filter((statement) => [statement.Action].flat().some((action: string) => action.startsWith('dynamodb:')))
      .map((statement) => statement.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']);
    assert.ok(leadingKeys.some((keys) => JSON.stringify(keys) === JSON.stringify(['SESSION#*'])));
    assert.ok(leadingKeys.some((keys) => JSON.stringify(keys) === JSON.stringify(['CONTENT#challenge#*'])));

    const method = Object.entries(resources).find(
      ([, resource]) =>
        resource.Type === 'AWS::ApiGateway::Method' && resource.Properties.OperationName === 'releaseHint',
    );
    assert.ok(method);
    assert.equal(method[1].Condition, 'GatewayPathEnabled');
    assert.equal(method[1].Properties.HttpMethod, 'POST');
    assert.equal(method[1].Properties.AuthorizationType, 'COGNITO_USER_POOLS');
    assert.equal(method[1].Properties.Integration.TimeoutInMillis, 8000);
    assert.ok(JSON.stringify(method[1].Properties.Integration.Uri).includes(functionId));

    const hintResource = Object.entries(resources).find(
      ([, resource]) => resource.Type === 'AWS::ApiGateway::Resource' && resource.Properties.PathPart === 'hints',
    );
    assert.ok(hintResource);
    assert.equal(hintResource[1].Condition, 'GatewayPathEnabled');
    assert.deepEqual(method[1].Properties.ResourceId, { Ref: hintResource[0] });
    const preflight = Object.values(resources).find(
      (resource) =>
        resource.Type === 'AWS::ApiGateway::Method' &&
        resource.Properties.HttpMethod === 'OPTIONS' &&
        JSON.stringify(resource.Properties.ResourceId) === JSON.stringify({ Ref: hintResource[0] }),
    );
    assert.ok(preflight);
    assert.equal(preflight.Condition, 'GatewayPathEnabled');
    assert.equal(preflight.Properties.AuthorizationType, 'NONE');
    assert.equal(preflight.Properties.Integration.Type, 'MOCK');

    const permission = Object.values(resources).find(
      (resource) =>
        resource.Type === 'AWS::Lambda::Permission' &&
        JSON.stringify(resource.Properties.FunctionName).includes(functionId),
    );
    assert.ok(permission);
    assert.equal(permission.Condition, 'GatewayPathEnabled');
    assert.ok(JSON.stringify(permission.Properties.SourceArn).includes('/*/POST/v1/sessions/*/hints'));

    const stage = Object.values(resources).find((resource) => resource.Type === 'AWS::ApiGateway::Stage');
    assert.ok(stage);
    assert.ok(
      stage.Properties.MethodSettings.some(
        (setting: Record<string, unknown>) =>
          setting.HttpMethod === 'POST' &&
          setting.ResourcePath === '/~1v1~1sessions~1{id}~1hints' &&
          setting.CachingEnabled === false &&
          setting.DataTraceEnabled === false &&
          setting.ThrottlingBurstLimit === 4 &&
          setting.ThrottlingRateLimit === 2,
      ),
    );
    const deployment = Object.values(resources).find((resource) => resource.Type === 'AWS::ApiGateway::Deployment');
    assert.ok(deployment);
    assert.ok([deployment.DependsOn].flat().includes(method[0]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
