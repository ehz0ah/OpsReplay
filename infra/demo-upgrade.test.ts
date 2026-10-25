import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

test('demo upgrade has its own default-off action, narrow role, authorizer, CORS and immutable deployment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'opsreplay-demo-upgrade-'));
  try {
    const stack = new SessionStartStack(new App({ outdir: directory }), 'DemoUpgradeTest');
    const rendered = Template.fromStack(stack).toJSON();
    assert.equal(rendered.Parameters.EnableDemoUpgrade.Default, 'false');
    assert.equal(rendered.Parameters.DemoUpgradeOwners.Default, '');
    assert.equal(rendered.Parameters.DemoUpgradeOwners.NoEcho, true);
    assert.equal(rendered.Parameters.DemoUpgradeExpiresAt.Default, '');
    assert.equal(rendered.Rules.DemoUpgradeRequiresApprovedWindow.Assertions.length, 3);
    const resources = Object.entries(rendered.Resources) as [
      string,
      { Type: string; Properties: Record<string, any>; DependsOn?: string[] },
    ][];
    const find = (id: string, type: string) =>
      resources.find(([name, value]) => name.startsWith(id) && value.Type === type)!;
    const [actionId, action] = find('DemoUpgrade', 'AWS::Lambda::Function');
    assert.equal(action.Properties.Runtime, 'nodejs22.x');
    assert.equal(action.Properties.Timeout, 10);
    assert.equal(action.Properties.MemorySize, 256);
    assert.deepEqual(action.Properties.ReservedConcurrentExecutions, { 'Fn::If': ['DemoUpgradeRuntimeEnabled', 2, 0] });
    assert.deepEqual(action.Properties.Environment.Variables.DEMO_UPGRADE_ENABLED, { Ref: 'EnableDemoUpgrade' });
    const [, iam] = find('DemoUpgradeRoleDefaultPolicy', 'AWS::IAM::Policy');
    const statements = iam.Properties.PolicyDocument.Statement;
    const dataStatement = statements.find((statement: any) => statement.Condition);
    assert.deepEqual(dataStatement.Action, ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:ConditionCheckItem']);
    assert.deepEqual(dataStatement.Condition, { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*'] } });
    assert.equal(JSON.stringify(statements).includes('ecs:'), false);
    assert.equal(JSON.stringify(statements).includes('scheduler:'), false);
    assert.equal(JSON.stringify(statements).includes('secretsmanager:'), false);
    const [methodId, method] = find('DemoUpgradeMethod', 'AWS::ApiGateway::Method');
    assert.equal(method.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
    assert.equal(method.Properties.HttpMethod, 'POST');
    assert.equal(JSON.stringify(method.Properties.Integration.Uri).includes(actionId), true);
    assert.equal(find('DemoUpgradeCors', 'AWS::ApiGateway::Method')[1].Properties.HttpMethod, 'OPTIONS');
    const [, deployment] = find('TerminalTicketApiDeploymentV13', 'AWS::ApiGateway::Deployment');
    assert.ok(deployment.DependsOn?.includes(methodId));
    const [, stage] = find('TerminalTicketApiStage', 'AWS::ApiGateway::Stage');
    const limits = stage.Properties.MethodSettings.find(
      (setting: any) => setting.ResourcePath === '/~1v1~1demo-upgrade',
    );
    assert.equal(limits.ThrottlingBurstLimit, 2);
    assert.equal(limits.ThrottlingRateLimit, 1);
    assert.equal(limits.DataTraceEnabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
