import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('review read and submit are separate authenticated actions without runtime or object access', () => {
  const template = Template.fromStack(new SessionStartStack(new App(), 'ReviewTest')).toJSON();
  const resources = template.Resources as Record<string, any>;
  for (const name of ['GetReview', 'SubmitReview']) {
    const fn = Object.entries(resources).find(([id, r]) => id.startsWith(name) && r.Type === 'AWS::Lambda::Function')!;
    assert.ok(fn);
    assert.deepEqual(fn[1].Properties.ReservedConcurrentExecutions, { 'Fn::If': ['GatewayPathEnabled', 2, 0] });
    const role = fn[1].Properties.Role['Fn::GetAtt'][0];
    const statements = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((v: any) => v.Ref === role))
      .flatMap((r) => r.Properties.PolicyDocument.Statement);
    const actions = statements.flatMap((s: any) => [s.Action].flat());
    assert.equal(
      actions.some((action: string) => /Scan|RunTask|InvokeFunction|s3:/.test(action)),
      false,
    );
    if (name === 'GetReview')
      assert.equal(
        actions.some((action: string) => /PutItem|UpdateItem|DeleteItem/.test(action)),
        false,
      );
  }
  const methods = Object.values(resources).filter(
    (r) => r.Type === 'AWS::ApiGateway::Method' && ['get-review', 'submit-review'].includes(r.Properties.OperationName),
  );
  assert.equal(methods.length, 2);
  assert.ok(methods.every((method) => method.Properties.AuthorizationType === 'COGNITO_USER_POOLS'));
});
