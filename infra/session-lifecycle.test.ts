import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('lifecycle has separate disabled action bundles, bounded triggers, narrow roles, and no direct Lambda calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-lifecycle-cdk-'));
  try {
    const template = Template.fromStack(new SessionStartStack(new App({ outdir: directory }), 'TestStart'));
    const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, any> }>;
    for (const name of ['EndSession', 'ReconcileSession', 'SweepSessions']) {
      const fn = Object.entries(resources).find(
        ([id, value]) => id.startsWith(name) && value.Type === 'AWS::Lambda::Function',
      );
      assert.ok(fn);
      assert.equal(fn[1].Properties.ReservedConcurrentExecutions, 0);
      assert.equal(fn[1].Properties.Runtime, 'nodejs22.x');
      assert.equal(fn[1].Properties.VpcConfig, undefined);
      assert.equal(
        fn[1].Properties.MemorySize,
        name === 'SweepSessions' ? 1024 : name === 'ReconcileSession' ? 512 : 256,
      );
      const role = fn[1].Properties.Role['Fn::GetAtt'][0];
      const statements = Object.values(resources)
        .filter((value) => value.Type === 'AWS::IAM::Policy' && JSON.stringify(value.Properties.Roles).includes(role))
        .flatMap((value) => value.Properties.PolicyDocument.Statement);
      const actions = statements.flatMap((statement) => [statement.Action].flat());
      assert.equal(actions.includes('lambda:InvokeFunction'), false);
      assert.equal(actions.includes('s3:GetObject'), name !== 'EndSession');
      if (name !== 'EndSession') {
        const reads = statements.filter((statement) => [statement.Action].flat().includes('s3:GetObject'));
        assert.equal(reads.length, 1);
        assert.ok(JSON.stringify(reads[0].Resource).includes('/metrics/*/sealed/*'));
        assert.ok(fn[1].Properties.Environment.Variables.RECORDING_BUCKET_NAME);
      }
      assert.equal(actions.includes('s3:DeleteObject'), false);
      if (name !== 'EndSession') {
        assert.equal(actions.includes('ecs:RunTask'), true);
        const bootstrap = statements.filter((statement) => [statement.Action].flat().includes('s3:PutObject'));
        assert.equal(bootstrap.length, 1);
        assert.ok(JSON.stringify(bootstrap[0].Resource).includes('MonitorSecretFiles'));
      }
      if (name === 'EndSession') {
        assert.equal(
          actions.some((action) => action.startsWith('ecs:') || action.startsWith('scheduler:')),
          false,
        );
        assert.equal(actions.includes('dynamodb:DeleteItem'), false);
        assert.equal(
          actions.some((action) => action.startsWith('s3:')),
          false,
        );
      }
    }
    const stream = Object.values(resources).find((value) => value.Type === 'AWS::Lambda::EventSourceMapping');
    assert.ok(stream);
    assert.equal(stream.Properties.Enabled, false);
    assert.equal(stream.Properties.BatchSize, 25);
    assert.equal(stream.Properties.MaximumRetryAttempts, 3);
    const pattern = JSON.parse(stream.Properties.FilterCriteria.Filters[0].Pattern);
    assert.deepEqual(pattern.dynamodb.Keys.SK.S, [{ prefix: 'LIFECYCLE_HINT#' }]);
    for (const [id, value] of Object.entries(resources).filter(
      ([id, value]) => id.startsWith('Lifecycle') && value.Type === 'AWS::Events::Rule',
    ))
      assert.equal(value.Properties.State, 'DISABLED', id);
    const end = Object.values(resources).find(
      (value) => value.Type === 'AWS::ApiGateway::Method' && value.Properties.OperationName === 'endSession',
    );
    assert.ok(end);
    assert.equal(end.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
    assert.equal(end.Properties.HttpMethod, 'POST');
    const table = Object.values(resources).find((value) => value.Type === 'AWS::DynamoDB::Table');
    assert.equal(table?.Properties.StreamSpecification.StreamViewType, 'KEYS_ONLY');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
