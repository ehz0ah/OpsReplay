import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BrowserHostingStack, browserRouteCode } from './browser-hosting-stack.js';
test('browser routes rewrite valid learner pages and keep assets, config, unknown and backend paths intact', () => {
  const run = runInNewContext(browserRouteCode + ';handler');
  for (const uri of [
    '/',
    '/auth/callback',
    '/history',
    '/review-submissions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '/reviews',
    '/reviews/proxy-rollout',
    '/learn',
    '/learn/safe-incident-recovery',
    '/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/debrief',
  ])
    assert.equal(run({ request: { uri } }).uri, '/index.html');
  for (const uri of [
    '/assets/app.js',
    '/config.json',
    '/learn/index.json',
    '/learn/safe-incident-recovery.json',
    '/learn/../private',
    '/v1/terminal',
    '/other',
    '/sessions/not-a-session',
    '/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/private',
  ])
    assert.equal(run({ request: { uri } }).uri, uri);
});
test('static browser uses private signed S3 reads, separate caches and no fallback for backend errors', () => {
  const template = Template.fromStack(new BrowserHostingStack(new App(), 'Browser'));
  const json = template.toJSON();
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.resourceCountIs('AWS::Lambda::Function', 0);
  template.resourceCountIs('AWS::Cognito::UserPool', 0);
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: {
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
      OriginAccessControlOriginType: 's3',
    },
  });
  const distribution = Object.values(json.Resources).find(
    (v: any) => v.Type === 'AWS::CloudFront::Distribution',
  ) as any;
  assert.equal(
    distribution.Properties.DistributionConfig.DefaultCacheBehavior.CachePolicyId,
    '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
  );
  assert.equal(distribution.Properties.DistributionConfig.CacheBehaviors[0].PathPattern, 'assets/*');
  assert.equal(
    distribution.Properties.DistributionConfig.CacheBehaviors[0].CachePolicyId,
    '658327ea-f89d-4fab-a63d-7e88639e58f6',
  );
  assert.ok(
    distribution.Properties.DistributionConfig.CustomErrorResponses.every(
      (v: any) => v.ResponseCode === undefined && v.ResponsePagePath === undefined,
    ),
  );
  const text = JSON.stringify(json);
  assert.match(text, /AWS:SourceArn/);
  assert.match(text, /frame-ancestors/);
  assert.doesNotMatch(text, /unsafe-eval/);
  for (const name of ['ApiOrigin', 'CognitoAuthorityOrigin', 'CognitoLoginOrigin', 'TerminalOrigin', 'RecordingOrigin'])
    assert.equal(json.Parameters[name].Default, '');
});
