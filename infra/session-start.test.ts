import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

test('the admission stack has one disabled action with table-only data access', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-cdk-'));
  try {
    const app = new App({ outdir: directory });
    const stack = new SessionStartStack(app, 'TestStart');
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x', Handler: 'index.handler', ReservedConcurrentExecutions: 0,
      Timeout: 10, MemorySize: 256,
    });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain',
      Properties: { BillingMode: 'PAY_PER_REQUEST' },
    });
    const resources = Object.values(template.toJSON().Resources) as { Type: string; Properties?: Record<string, unknown> }[];
    const allowed = new Set(['AWS::Lambda::Function', 'AWS::DynamoDB::Table', 'AWS::IAM::Role', 'AWS::IAM::Policy', 'AWS::Logs::LogGroup']);
    for (const resource of resources) assert.ok(allowed.has(resource.Type), `Unexpected resource: ${resource.Type}`);
    const actions = new Set<string>();
    for (const resource of resources.filter(item => item.Type === 'AWS::IAM::Policy')) {
      const document = resource.Properties?.PolicyDocument as { Statement: { Action: string | string[]; Resource: unknown }[] };
      for (const statement of document.Statement) {
        assert.notEqual(statement.Resource, '*');
        for (const action of [statement.Action].flat()) actions.add(action);
      }
    }
    assert.deepEqual([...actions].sort(), [
      'dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem',
      'logs:CreateLogStream', 'logs:PutLogEvents',
    ]);
    const fn = resources.find(item => item.Type === 'AWS::Lambda::Function')!;
    assert.equal(fn.Properties?.VpcConfig, undefined);
    const role = resources.find(item => item.Type === 'AWS::IAM::Role')!;
    assert.equal(role.Properties?.ManagedPolicyArns, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
