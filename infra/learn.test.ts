import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('Learn read is a separate disabled action with only content read permissions', () => {
  const template = Template.fromStack(new SessionStartStack(new App(), 'LearnTest')).toJSON();
  const resources = template.Resources as Record<string, any>;
  const fn = Object.entries(resources).find(
    ([id, r]) => id.startsWith('GetLearn') && r.Type === 'AWS::Lambda::Function',
  )!;
  assert.ok(fn);
  assert.deepEqual(fn[1].Properties.ReservedConcurrentExecutions, { 'Fn::If': ['GatewayPathEnabled', 2, 0] });
  assert.equal(fn[1].Properties.VpcConfig, undefined);
  const role = fn[1].Properties.Role['Fn::GetAtt'][0];
  const statements = Object.values(resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((v: any) => v.Ref === role))
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
  const actions = statements.flatMap((s: any) => [s.Action].flat());
  assert.equal(
    actions.some((s: string) => /Scan|PutItem|UpdateItem|DeleteItem|RunTask|InvokeFunction/.test(s)),
    false,
  );
  assert.ok(JSON.stringify(statements).includes('content/learn/*'));
  const method = Object.values(resources).find(
    (r) => r.Type === 'AWS::ApiGateway::Method' && r.Properties.OperationName === 'get-learn',
  )!;
  assert.equal(method.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
  assert.equal(method.Condition, 'GatewayPathEnabled');
});
