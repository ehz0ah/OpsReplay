import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
test('bootstrap routes preserve public catalogue and authenticated read-only account boundaries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-bootstrap-'));
  try {
    const template = Template.fromStack(
      new SessionStartStack(new App({ outdir: directory }), 'TestBootstrap'),
    ).toJSON();
    const resources = template.Resources as Record<string, any>;
    for (const [prefix, operation, partition] of [
      ['ListCatalog', 'listCatalog', 'CATALOG#PUBLIC'],
      ['GetAccount', 'getAccount', 'USER#*'],
    ]) {
      const fn = Object.entries(resources).find(
        ([id, r]) => id.startsWith(prefix!) && r.Type === 'AWS::Lambda::Function',
      )!;
      assert.ok(fn);
      assert.equal(fn[1].Properties.VpcConfig, undefined);
      assert.deepEqual(
        fn[1].Properties.Environment.Variables.SESSION_ADMISSION_ENABLED,
        prefix === 'GetAccount' ? { 'Fn::If': ['SessionAdmissionEnabled', 'true', 'false'] } : undefined,
      );
      assert.deepEqual(fn[1].Properties.ReservedConcurrentExecutions, {
        'Fn::If': ['GatewayPathEnabled', { Ref: 'BootstrapReadBurstLimit' }, 0],
      });
      const role = fn[1].Properties.Role['Fn::GetAtt'][0];
      const statements = Object.values(resources)
        .filter((r: any) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles?.some((v: any) => v.Ref === role))
        .flatMap((r: any) => r.Properties.PolicyDocument.Statement);
      const actions = statements.flatMap((s: any) => [s.Action].flat());
      assert.equal(
        actions.some((s: string) => /Scan|PutItem|UpdateItem|DeleteItem|RunTask|InvokeFunction/.test(s)),
        false,
      );
      assert.ok(JSON.stringify(statements).includes(partition!));
      if (prefix === 'ListCatalog') assert.equal(JSON.stringify(statements).includes('CONTENT#'), false);
      const method = Object.values(resources).find(
        (r: any) => r.Type === 'AWS::ApiGateway::Method' && r.Properties.OperationName === operation,
      ) as any;
      assert.equal(method.Properties.AuthorizationType, prefix === 'ListCatalog' ? 'NONE' : 'COGNITO_USER_POOLS');
      assert.equal(method.Condition, 'GatewayPathEnabled');
    }
    assert.deepEqual(template.Parameters.BootstrapReadBurstLimit, {
      Type: 'Number',
      Default: 4,
      MinValue: 1,
      MaxValue: 64,
      Description: 'Burst and per-action Lambda concurrency for each catalogue/account read route.',
    });
    assert.equal(template.Parameters.BootstrapReadRateLimit.Default, 2);
    assert.equal(template.Parameters.BootstrapReadRateLimit.MinValue, 1);
    assert.equal(template.Parameters.BootstrapReadRateLimit.MaxValue, 64);
    const stage = Object.values(resources).find((resource: any) => resource.Type === 'AWS::ApiGateway::Stage') as any;
    for (const path of ['catalog', 'me']) {
      const setting = stage.Properties.MethodSettings.find((row: any) => row.ResourcePath === `/~1v1~1${path}`);
      assert.equal(setting.HttpMethod, 'GET');
      assert.equal(setting.CachingEnabled, false);
      assert.deepEqual(setting.ThrottlingBurstLimit, { Ref: 'BootstrapReadBurstLimit' });
      assert.deepEqual(setting.ThrottlingRateLimit, { Ref: 'BootstrapReadRateLimit' });
    }
    assert.equal(
      Object.values(resources).some((r: any) => r.Type === 'AWS::DynamoDB::Table'),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
