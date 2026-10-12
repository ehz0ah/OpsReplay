import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ContentPublicationStack } from './content-publication-stack.js';

test('content publication uses a separate exact-trust role with read and conditional-write permissions only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-content-publication-'));
  try {
    const app = new App({ outdir: directory });
    const stack = new ContentPublicationStack(app, 'TestContentPublication');
    const rendered = Template.fromStack(stack).toJSON();
    const resources = Object.values(rendered.Resources) as { Type: string; Properties?: Record<string, unknown> }[];
    assert.equal(resources.filter((resource) => resource.Type === 'AWS::IAM::Role').length, 1);
    assert.equal(resources.filter((resource) => resource.Type === 'AWS::IAM::Policy').length, 1);
    assert.equal(
      resources.some((resource) => !['AWS::IAM::Role', 'AWS::IAM::Policy'].includes(resource.Type)),
      false,
    );
    const role = resources.find((resource) => resource.Type === 'AWS::IAM::Role');
    assert.deepEqual(role?.Properties?.AssumeRolePolicyDocument, {
      Statement: [
        {
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:ehz0ah@130889443/OpsReplay@1378586293:environment:aws-checkpoint',
            },
          },
          Effect: 'Allow',
          Principal: { Federated: { Ref: 'GitHubOidcProviderArn' } },
        },
      ],
      Version: '2012-10-17',
    });
    const policy = resources.find((resource) => resource.Type === 'AWS::IAM::Policy');
    assert.ok(policy?.Properties);
    const statements = (policy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement;
    assert.deepEqual(
      statements.map((statement) => statement.Action),
      [['dynamodb:GetItem', 'dynamodb:PutItem'], 'ecr:BatchGetImage', 'ecs:DescribeTaskDefinition'],
    );
    assert.deepEqual(statements[0]?.Condition, {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONTENT#*'] },
    });
    assert.equal(
      statements.some((statement) => JSON.stringify(statement.Action).includes('ecr:PutImage')),
      false,
    );
    assert.equal(
      statements.some((statement) => JSON.stringify(statement.Action).includes('iam:PassRole')),
      false,
    );
    assert.equal(
      statements.some((statement) => JSON.stringify(statement.Action).includes('ecs:RegisterTaskDefinition')),
      false,
    );
    assert.equal(statements[2]?.Resource, '*');
    assert.deepEqual(Object.keys(rendered.Outputs), ['GitHubContentPublisherRoleArn']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
