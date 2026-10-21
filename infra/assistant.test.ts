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
  assert.deepEqual(send.Properties.ReservedConcurrentExecutions, {
    'Fn::If': ['AssistantActive', { Ref: 'AssistantConcurrencyLimit' }, 0],
  });
  assert.equal(template.Parameters.AssistantEnabled.Default, 'false');
  const endpoint = new RegExp(template.Parameters.AssistantEndpoint.AllowedPattern);
  for (const value of [
    '',
    'https://api.example/v1/chat/completions',
    'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  ])
    assert.equal(endpoint.test(value), true);
  for (const value of [
    'http://api.example/api/v3/chat/completions',
    'https://user:secret@api.example/api/v3/chat/completions',
    'https://api.example/api/v3/chat/completions?key=secret',
    'https://api.example/api/v3/chat/completions#fragment',
    'https://api.example/api/v3/responses',
    'https://api.example/other/chat/completions',
  ])
    assert.equal(endpoint.test(value), false);
  for (const name of ['AssistantConcurrencyLimit', 'AssistantRateLimit']) {
    assert.equal(template.Parameters[name].Default, 1);
    assert.equal(template.Parameters[name].MinValue, 1);
    assert.equal(template.Parameters[name].MaxValue, 64);
  }
  const stage = find('TerminalTicketApiStage', 'AWS::ApiGateway::Stage')[1];
  const post = stage.Properties.MethodSettings.find(
    (setting: any) => setting.HttpMethod === 'POST' && setting.ResourcePath === '/~1v1~1sessions~1{id}~1messages',
  );
  assert.deepEqual(post.ThrottlingBurstLimit, { Ref: 'AssistantConcurrencyLimit' });
  assert.deepEqual(post.ThrottlingRateLimit, { Ref: 'AssistantRateLimit' });
  assert.equal(post.DataTraceEnabled, false);
  const getLimit = stage.Properties.MethodSettings.find(
    (setting: any) => setting.ResourcePath === '/~1v1~1sessions~1{id}~1messages~1{turnId}',
  );
  assert.equal(getLimit.ThrottlingBurstLimit, 2);
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
