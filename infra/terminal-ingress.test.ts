import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';
import { TerminalEdgeProtectionStack } from './terminal-edge-protection-stack.js';

type Resource = {
  Type: string;
  Condition?: string;
  DependsOn?: string | string[];
  Properties: Record<string, unknown>;
};

test('CloudFront preserves terminal authentication inputs and uses only a protected private origin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-cloudfront-'));
  try {
    const template = Template.fromStack(new SessionStartStack(new App({ outdir: directory }), 'TestIngress'));
    const rendered = template.toJSON() as {
      Parameters: Record<string, unknown>;
      Resources: Record<string, Resource>;
      Outputs: Record<string, { Condition?: string; Value: unknown }>;
    };
    for (const removed of [
      'PublicIngressSubnetIds',
      'TerminalCertificateArn',
      'TerminalGatewayUrl',
      'TerminalUpgradeRateLimitPerIp',
    ]) {
      assert.equal(rendered.Parameters[removed], undefined, `${removed} must not remain an external runtime input`);
    }
    for (const type of [
      'AWS::CloudFront::Distribution',
      'AWS::CloudFront::VpcOrigin',
      'AWS::CloudFront::OriginRequestPolicy',
    ]) {
      template.resourceCountIs(type, 1);
      const resource = Object.values(rendered.Resources).find((item) => item.Type === type);
      assert.equal(resource?.Condition, 'GatewayPathEnabled');
    }
    template.hasResourceProperties('AWS::CloudFront::VpcOrigin', {
      VpcOriginEndpointConfig: Match.objectLike({
        Arn: { Ref: 'TerminalLoadBalancer' },
        HTTPPort: 80,
        OriginProtocolPolicy: 'http-only',
      }),
    });
    assert.ok([rendered.Resources.TerminalVpcOrigin!.DependsOn].flat().includes('TerminalWebSocketRoute'));
    template.hasResourceProperties('AWS::CloudFront::OriginRequestPolicy', {
      OriginRequestPolicyConfig: Match.objectLike({
        HeadersConfig: {
          HeaderBehavior: 'whitelist',
          Headers: [
            'Origin',
            'Sec-WebSocket-Key',
            'Sec-WebSocket-Version',
            'Sec-WebSocket-Protocol',
            'Sec-WebSocket-Accept',
            'Sec-WebSocket-Extensions',
          ],
        },
        CookiesConfig: { CookieBehavior: 'none' },
        QueryStringsConfig: { QueryStringBehavior: 'all' },
      }),
    });
    const config = rendered.Resources.TerminalDistribution!.Properties.DistributionConfig as Record<string, unknown>;
    assert.equal(config.Enabled, true);
    assert.equal(config.HttpVersion, 'http1.1');
    assert.deepEqual(config.ViewerCertificate, { CloudFrontDefaultCertificate: true });
    assert.deepEqual(config.WebACLId, { Ref: 'TerminalEdgeWebAclArn' });
    assert.equal(config.Aliases, undefined);
    assert.equal(config.CacheBehaviors, undefined, 'Frontend and API hosting are outside terminal ingress.');
    assert.deepEqual(config.DefaultCacheBehavior, {
      TargetOriginId: 'terminal-gateway',
      ViewerProtocolPolicy: 'https-only',
      AllowedMethods: ['GET', 'HEAD'],
      CachedMethods: ['GET', 'HEAD'],
      CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
      OriginRequestPolicyId: { Ref: 'TerminalOriginRequestPolicy' },
      Compress: false,
    });
    const origins = config.Origins as Record<string, unknown>[];
    assert.equal(origins.length, 1);
    assert.deepEqual(origins[0]!.VpcOriginConfig, {
      VpcOriginId: { 'Fn::GetAtt': ['TerminalVpcOrigin', 'Id'] },
      OriginReadTimeout: 30,
      OriginKeepaliveTimeout: 5,
    });
    assert.equal(origins[0]!.CustomOriginConfig, undefined, 'The ALB must not be reached as a public origin.');
    assert.deepEqual(origins[0]!.DomainName, { 'Fn::GetAtt': ['TerminalLoadBalancer', 'DNSName'] });
    const errors = config.CustomErrorResponses as { ErrorCode: number; ErrorCachingMinTTL: number }[];
    assert.ok(errors.some((item) => item.ErrorCode === 403));
    assert.ok(errors.some((item) => item.ErrorCode === 503));
    assert.ok(errors.every((item) => item.ErrorCachingMinTTL === 0));
    const expectedUrl = {
      'Fn::Join': ['', ['wss://', { 'Fn::GetAtt': ['TerminalDistribution', 'DomainName'] }, '/v1/terminal']],
    };
    assert.deepEqual(rendered.Outputs.TerminalGatewayUrl, { Value: expectedUrl, Condition: 'GatewayPathEnabled' });
    const ticket = Object.entries(rendered.Resources).find(
      ([id, item]) => id.startsWith('CreateTerminalTicket') && item.Type === 'AWS::Lambda::Function',
    );
    assert.ok(ticket);
    const environment = ticket[1].Properties.Environment as { Variables: Record<string, unknown> };
    assert.deepEqual(environment.Variables.TERMINAL_GATEWAY_URL, { 'Fn::If': ['GatewayPathEnabled', expectedUrl, ''] });
    for (const output of ['TerminalDistributionId', 'TerminalDistributionDomainName', 'TerminalVpcOriginId']) {
      assert.equal(rendered.Outputs[output]?.Condition, 'GatewayPathEnabled');
    }
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);

    // Ref/GetAtt and explicit dependencies must not form a deployment cycle.
    const references = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(references);
      if (value === null || typeof value !== 'object') return [];
      const object = value as Record<string, unknown>;
      if (typeof object.Ref === 'string') return [object.Ref];
      if (Array.isArray(object['Fn::GetAtt'])) return [object['Fn::GetAtt'][0] as string];
      return Object.values(object).flatMap(references);
    };
    const visited = new Set<string>();
    const visit = (id: string, path: string[]) => {
      assert.ok(!path.includes(id), `Deployment dependency cycle: ${[...path, id].join(' -> ')}`);
      if (visited.has(id)) return;
      const resource = rendered.Resources[id];
      if (resource === undefined) return;
      const dependencies = [...[resource.DependsOn ?? []].flat(), ...references(resource.Properties)];
      for (const dependency of dependencies) visit(dependency, [...path, id]);
      visited.add(id);
    };
    for (const id of Object.keys(rendered.Resources)) visit(id, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('edge WAF is default-off in us-east-1 and rate limits viewer IP without trusting forwarded headers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-edge-waf-'));
  try {
    const app = new App({ outdir: directory });
    assert.throws(
      () => new TerminalEdgeProtectionStack(app, 'WrongRegion', { env: { region: 'ap-southeast-1' } }),
      /us-east-1/,
    );
    const stack = new TerminalEdgeProtectionStack(app, 'TestEdge');
    assert.equal(stack.region, 'us-east-1');
    const template = Template.fromStack(stack);
    const rendered = template.toJSON();
    assert.equal(rendered.Parameters.EnableTerminalEdgeProtection.Default, 'false');
    assert.equal(rendered.Parameters.TerminalUpgradeRateLimitPerIp.Default, 300);
    assert.equal(rendered.Parameters.TerminalUpgradeRateLimitPerIp.MinValue, 10);
    assert.equal(rendered.Resources.TerminalWebAcl.Condition, 'TerminalEdgeProtectionEnabled');
    const acl = rendered.Resources.TerminalWebAcl.Properties;
    assert.equal(acl.Scope, 'CLOUDFRONT');
    assert.deepEqual(acl.DefaultAction, { Allow: {} });
    assert.equal(acl.VisibilityConfig.SampledRequestsEnabled, false);
    assert.equal(acl.Rules.length, 1);
    assert.deepEqual(acl.Rules[0].Action, { Block: {} });
    assert.deepEqual(acl.Rules[0].Statement.RateBasedStatement, {
      AggregateKeyType: 'IP',
      EvaluationWindowSec: 60,
      Limit: { Ref: 'TerminalUpgradeRateLimitPerIp' },
      ScopeDownStatement: {
        ByteMatchStatement: {
          FieldToMatch: { UriPath: {} },
          PositionalConstraint: 'EXACTLY',
          SearchString: '/v1/terminal',
          TextTransformations: [{ Priority: 0, Type: 'NONE' }],
        },
      },
    });
    assert.equal(acl.Rules[0].VisibilityConfig.SampledRequestsEnabled, false);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    assert.equal(rendered.Outputs.TerminalEdgeWebAclArn.Condition, 'TerminalEdgeProtectionEnabled');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
