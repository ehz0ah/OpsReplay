import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GitHubOidcProviderStack } from './github-oidc-provider-stack.js';

test('the account prerequisite contains only the GitHub Actions OIDC provider', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-github-oidc-provider-'));
  try {
    const app = new App({ outdir: directory });
    const stack = new GitHubOidcProviderStack(app, 'TestGitHubOidcProvider');
    const template = Template.fromStack(stack);
    const rendered = template.toJSON() as {
      Resources: Record<string, { Type: string }>;
      Outputs: Record<string, { Value: unknown }>;
    };

    assert.deepEqual(
      Object.values(rendered.Resources).map((resource) => resource.Type),
      ['AWS::IAM::OIDCProvider'],
    );
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      ClientIdList: ['sts.amazonaws.com'],
      Url: 'https://token.actions.githubusercontent.com',
    });
    assert.deepEqual(rendered.Outputs.GitHubOidcProviderArn, {
      Value: { Ref: Object.keys(rendered.Resources)[0] },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
