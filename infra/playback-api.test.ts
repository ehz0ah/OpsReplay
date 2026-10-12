import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('result reads have isolated conditionally enabled bundles, read-only roles and authenticated bounded routes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-results-cdk-'));
  try {
    const resources = Template.fromStack(new SessionStartStack(new App({ outdir: directory }), 'Test')).toJSON()
      .Resources as Record<string, any>;
    const bundles = new Set<string>();
    const roles = new Set<string>();
    for (const [name, path] of [
      ['GetDebrief', 'debrief'],
      ['ListTimeline', 'timeline'],
      ['GetPlayback', 'playback'],
    ]) {
      const [id, fn] = Object.entries(resources).find(
        ([id, value]) => id.startsWith(name!) && value.Type === 'AWS::Lambda::Function',
      )!;
      assert.deepEqual(fn.Properties.ReservedConcurrentExecutions, {
        'Fn::If': ['GatewayPathEnabled', 4, 0],
      });
      assert.equal(fn.Properties.VpcConfig, undefined);
      assert.equal(fn.Properties.Timeout, path === 'debrief' ? 10 : 25);
      bundles.add(JSON.stringify(fn.Properties.Code));
      roles.add(JSON.stringify(fn.Properties.Role));
      const role = fn.Properties.Role['Fn::GetAtt'][0];
      const statements = Object.values(resources)
        .filter((v) => v.Type === 'AWS::IAM::Policy' && JSON.stringify(v.Properties.Roles).includes(role))
        .flatMap((v) => v.Properties.PolicyDocument.Statement);
      const actions = statements.flatMap((v) => [v.Action].flat());
      assert.equal(
        actions.some((v) => /Put|Delete|Update|Invoke|RunTask|StopTask/.test(v) && !v.startsWith('logs:')),
        false,
      );
      assert.equal(actions.includes('dynamodb:Query'), path !== 'debrief');
      assert.equal(actions.includes('s3:GetObject'), path !== 'debrief');
      const reads = statements.filter((v) => [v.Action].flat().includes('s3:GetObject'));
      if (path === 'playback') {
        assert.ok(JSON.stringify(reads).includes('/sessions/*/playback/*'));
        assert.ok(JSON.stringify(reads).includes('/sessions/*/captures/*'));
      }
      if (path === 'timeline') assert.ok(JSON.stringify(reads).includes('/sessions/*/metrics/*/sealed/*'));
      const method = Object.values(resources).find(
        (v) =>
          v.Type === 'AWS::ApiGateway::Method' &&
          v.Properties.OperationName ===
            ({ debrief: 'get-debrief', timeline: 'list-timeline', playback: 'get-playback' } as Record<string, string>)[
              path!
            ],
      )!;
      assert.equal(method.Condition, 'GatewayPathEnabled');
      assert.equal(method.Properties.HttpMethod, 'GET');
      assert.equal(method.Properties.AuthorizationType, 'COGNITO_USER_POOLS');
      assert.ok(JSON.stringify(method.Properties.Integration).includes(id));
      assert.equal(method.Properties.Integration.TimeoutInMillis, path === 'debrief' ? 8000 : 23000);
    }
    for (const name of ['ReconcileSession', 'SweepSessions']) {
      const fn = Object.entries(resources).find(
        ([id, value]) => id.startsWith(name) && value.Type === 'AWS::Lambda::Function',
      )![1];
      const role = fn.Properties.Role['Fn::GetAtt'][0];
      const statements = Object.values(resources)
        .filter((v) => v.Type === 'AWS::IAM::Policy' && JSON.stringify(v.Properties.Roles).includes(role))
        .flatMap((v) => v.Properties.PolicyDocument.Statement);
      const put = statements.find((v) => v.Effect === 'Allow' && [v.Action].flat().includes('s3:PutObject'));
      assert.deepEqual(put.Condition.StringEquals['s3:RequestObjectTag/opsreplay-retention'], [
        'provisional',
        'sealed',
      ]);
      assert.deepEqual(put.Condition['ForAllValues:StringEquals']['s3:RequestObjectTagKeys'], ['opsreplay-retention']);
      assert.ok(JSON.stringify(put.Resource).includes('/sessions/*/playback/*'));
      const deny = statements.find((v) => v.Effect === 'Deny' && [v.Action].flat().includes('s3:PutObjectTagging'));
      assert.equal(deny.Condition.Null['s3:ExistingObjectTag/opsreplay-retention'], 'false');
    }
    assert.equal(bundles.size, 3);
    assert.equal(roles.size, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
