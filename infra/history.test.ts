import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('history actions use bounded authenticated owner reads without scans or new indexes', () => {
  const resources = Template.fromStack(new SessionStartStack(new App(), 'HistoryTest')).toJSON().Resources as Record<
    string,
    any
  >;
  for (const name of ['ListSessions', 'ListReviewSubmissions', 'GetReviewSubmission']) {
    const fn = Object.entries(resources).find(([id, r]) => id.startsWith(name) && r.Type === 'AWS::Lambda::Function')!;
    assert.ok(fn);
    assert.deepEqual(fn[1].Properties.ReservedConcurrentExecutions, { 'Fn::If': ['GatewayPathEnabled', 2, 0] });
    const role = fn[1].Properties.Role['Fn::GetAtt'][0];
    const actions = Object.values(resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((v: any) => v.Ref === role))
      .flatMap((r) => r.Properties.PolicyDocument.Statement)
      .flatMap((s: any) => [s.Action].flat());
    assert.equal(
      actions.some((a: string) => /Scan|PutItem|UpdateItem|RunTask|InvokeFunction/.test(a)),
      false,
    );
  }
  assert.equal(
    Object.values(resources).some((r) => r.Type === 'AWS::DynamoDB::Table'),
    false,
  );
});
