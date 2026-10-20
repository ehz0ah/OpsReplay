import assert from 'node:assert/strict';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionDeletionStack } from './session-deletion-stack.js';
test('deletion is disabled by default, IAM-only and limited to session data', () => {
  const template = Template.fromStack(new SessionDeletionStack(new App(), 'DeletionTest')).toJSON();
  assert.equal(template.Parameters.EnableSessionDeletion.Default, 'false');
  const resources = Object.values(template.Resources) as any[];
  const fn = resources.find((r) => r.Type === 'AWS::Lambda::Function');
  assert.deepEqual(fn.Properties.ReservedConcurrentExecutions, { 'Fn::If': ['SessionDeletionEnabled', 1, 0] });
  assert.equal(fn.Properties.Timeout, 60);
  assert.equal(
    resources.some((r) => /ApiGateway|Permission|EventSourceMapping|DynamoDB::Table|S3::Bucket/.test(r.Type)),
    false,
  );
  const statements = resources
    .filter((r) => r.Type === 'AWS::IAM::Policy')
    .flatMap((r) => r.Properties.PolicyDocument.Statement);
  const actions = statements.flatMap((s) => [s.Action].flat());
  assert.equal(
    actions.some((a) => /Scan|RunTask|StopTask|InvokeFunction|GetObject|DeleteObjectVersion/.test(a)),
    false,
  );
  assert.ok(actions.includes('s3:DeleteObject'));
  const listing = statements.find((s) => [s.Action].flat().includes('s3:ListBucket'));
  assert.deepEqual(listing.Condition, { StringLike: { 's3:prefix': ['sessions/*/'] } });
});
