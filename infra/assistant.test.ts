import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('assistant has isolated streaming action, optional configuration and bounded expiry discovery', () => {
  const template = Template.fromStack(new SessionStartStack(new App(), 'AssistantTest')).toJSON();
  const resources = template.Resources as Record<string, any>;
  const find = (prefix: string, type: string) =>
    Object.entries(resources).find(([id, r]) => id.startsWith(prefix) && r.Type === type)!;
  const send = find('SendSessionMessage', 'AWS::Lambda::Function')[1];
  const get = find('GetSessionTurn', 'AWS::Lambda::Function')[1];
  assert.notDeepEqual(send.Properties.Role, get.Properties.Role);
  assert.equal(send.Properties.Timeout, 70);
  assert.deepEqual(send.Properties.ReservedConcurrentExecutions, { 'Fn::If': ['AssistantActive', 1, 0] });
  assert.equal(template.Parameters.AssistantEnabled.Default, 'false');
  const method = find('SendSessionMessageMethod', 'AWS::ApiGateway::Method')[1];
  assert.equal(method.Condition, 'GatewayPathEnabled');
  assert.equal(method.Properties.Integration.ResponseTransferMode, 'STREAM');
  assert.match(JSON.stringify(method.Properties.Integration.Uri), /response-streaming-invocations/);
  const policy = find('AssistantCredentialPolicy', 'AWS::IAM::Policy')[1];
  assert.equal(policy.Condition, 'AssistantActive');
  const statements = policy.Properties.PolicyDocument.Statement;
  assert.ok(
    statements.some(
      (s: any) => s.Action === 'secretsmanager:GetSecretValue' && s.Resource.Ref === 'AssistantSecretArn',
    ),
  );
  assert.equal(
    statements.some((s: any) => JSON.stringify(s.Action).includes('InvokeFunction')),
    false,
  );
  const sweepRole = find('SweepSessionsRole', 'AWS::IAM::Role')[0];
  assert.ok(
    Object.values(resources).some(
      (r) =>
        r.Type === 'AWS::IAM::Policy' &&
        r.Properties.Roles?.some((v: any) => v.Ref === sweepRole) &&
        r.Properties.PolicyDocument.Statement.some((s: any) => JSON.stringify(s.Condition ?? {}).includes('ASSISTANT')),
    ),
  );
});
