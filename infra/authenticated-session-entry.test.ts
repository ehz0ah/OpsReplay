import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

type Resource = {
  Type: string;
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
  Properties?: Record<string, any>;
};

test('authenticated session entry uses a durable pool and optional disposable client resources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-session-entry-'));
  try {
    const rendered = Template.fromStack(new SessionStartStack(new App({ outdir: directory }), 'TestEntry')).toJSON();
    const resources = rendered.Resources as Record<string, Resource>;
    const ofType = (type: string) => Object.entries(resources).filter(([, value]) => value.Type === type);

    assert.deepEqual(rendered.Parameters.CognitoIdentityMode, {
      Type: 'String',
      Default: 'external',
      AllowedValues: ['external', 'managed'],
      Description: 'Use an existing client and login domain, or create disposable checkpoint-owned values.',
    });
    assert.deepEqual(rendered.Parameters.CognitoUserPoolArn, {
      Type: 'String',
      AllowedPattern: 'arn:aws[a-z-]*:cognito-idp:[a-z0-9-]+:[0-9]{12}:userpool/[A-Za-z0-9_-]+',
      Description: 'Existing durable learner user pool ARN.',
    });
    const origin = new RegExp(rendered.Parameters.PublicApiAllowedOrigin.AllowedPattern);
    for (const value of ['', 'https://app.opsreplay.test', 'http://localhost:3000']) assert.match(value, origin);
    for (const value of [
      '*',
      'null',
      'http://app.opsreplay.test',
      'https://app.opsreplay.test/path',
      'https://user@app.opsreplay.test',
    ])
      assert.doesNotMatch(value, origin);
    for (const parameter of ['BrowserCallbackUrl', 'BrowserLogoutUrl']) {
      const redirect = new RegExp(rendered.Parameters[parameter].AllowedPattern);
      assert.match('https://app.opsreplay.test/auth/callback', redirect);
      assert.match('http://localhost:3000/auth/callback', redirect);
      assert.doesNotMatch('http://app.opsreplay.test/auth/callback', redirect);
      assert.doesNotMatch('https://app.opsreplay.test/auth/callback?next=other', redirect);
    }

    assert.ok(rendered.Rules.ExternalCognitoConfigurationRequired);
    assert.ok(rendered.Rules.ManagedCognitoConfigurationRequired);
    assert.equal(ofType('AWS::Cognito::IdentityPool').length, 0);
    assert.equal(ofType('AWS::Cognito::UserPool').length, 0);
    const [client] = ofType('AWS::Cognito::UserPoolClient');
    const [domain] = ofType('AWS::Cognito::UserPoolDomain');
    assert.ok(client && domain);
    assert.equal(client[1].Condition, 'ManagedCognitoIdentity');
    assert.deepEqual(client[1].Properties, {
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      CallbackURLs: [{ Ref: 'BrowserCallbackUrl' }],
      ClientName: 'opsreplay-browser',
      EnableTokenRevocation: true,
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      GenerateSecret: false,
      LogoutURLs: [{ Ref: 'BrowserLogoutUrl' }],
      PreventUserExistenceErrors: 'ENABLED',
      SupportedIdentityProviders: ['COGNITO'],
      UserPoolId: {
        'Fn::Select': [1, { 'Fn::Split': ['/', { Ref: 'CognitoUserPoolArn' }] }],
      },
    });
    assert.equal(domain[1].Condition, 'ManagedCognitoIdentity');
    assert.deepEqual(domain[1].Properties, {
      Domain: { Ref: 'CognitoDomainPrefix' },
      UserPoolId: {
        'Fn::Select': [1, { 'Fn::Split': ['/', { Ref: 'CognitoUserPoolArn' }] }],
      },
    });

    const [authorizer] = ofType('AWS::ApiGateway::Authorizer');
    assert.ok(authorizer);
    assert.equal(authorizer[1].Condition, 'GatewayPathEnabled');
    assert.deepEqual(authorizer[1].Properties?.ProviderARNs, [{ Ref: 'CognitoUserPoolArn' }]);

    const methods = ofType('AWS::ApiGateway::Method');
    // The demo action adds one authenticated POST and one OPTIONS method.
    assert.equal(methods.length, 37);
    const actions = methods.filter(([, value]) => value.Properties?.HttpMethod !== 'OPTIONS');
    const options = methods.filter(([, value]) => value.Properties?.HttpMethod === 'OPTIONS');
    assert.equal(actions.length, 19);
    assert.equal(options.length, 18);
    for (const [, method] of actions) {
      assert.equal(method.Condition, 'GatewayPathEnabled');
      if (method.Properties?.OperationName === 'listCatalog') {
        assert.equal(method.Properties?.AuthorizationType, 'NONE');
        assert.equal(method.Properties?.AuthorizerId, undefined);
      } else {
        assert.equal(method.Properties?.AuthorizationType, 'COGNITO_USER_POOLS');
        assert.deepEqual(method.Properties?.AuthorizerId, { Ref: authorizer[0] });
      }
    }
    for (const [, method] of options) {
      assert.equal(method.Condition, 'GatewayPathEnabled');
      assert.equal(method.Properties?.AuthorizationType, 'NONE');
      assert.equal(method.Properties?.Integration.Type, 'MOCK');
      assert.equal(method.Properties?.Integration.IntegrationResponses[0].StatusCode, '204');
      const responseParameters = method.Properties?.Integration.IntegrationResponses[0].ResponseParameters;
      assert.ok(
        ["'GET,OPTIONS'", "'OPTIONS,POST'", "'GET,OPTIONS,POST'"].includes(
          responseParameters['method.response.header.Access-Control-Allow-Methods'],
        ),
      );
      const fixedResponseParameters = { ...responseParameters };
      delete fixedResponseParameters['method.response.header.Access-Control-Allow-Methods'];
      assert.deepEqual(fixedResponseParameters, {
        'method.response.header.Access-Control-Allow-Headers': "'Authorization,Content-Type'",
        'method.response.header.Access-Control-Allow-Origin': {
          'Fn::Join': ['', ["'", { Ref: 'PublicApiAllowedOrigin' }, "'"]],
        },
        'method.response.header.Cache-Control': "'no-store'",
        'method.response.header.Vary': "'Origin'",
      });
      assert.equal(
        method.Properties?.Integration.IntegrationResponses[0].ResponseParameters[
          'method.response.header.Access-Control-Allow-Credentials'
        ],
        undefined,
      );
    }

    const start = actions.find(([, value]) => value.Properties?.OperationName === 'startSession');
    assert.ok(start);
    assert.equal(start[1].Properties?.Integration.TimeoutInMillis, 21_000);
    const permissions = ofType('AWS::Lambda::Permission').filter(
      ([, value]) => value.Properties?.Principal === 'apigateway.amazonaws.com',
    );
    assert.equal(permissions.length, 19);
    const startPermission = permissions.find(([, value]) =>
      JSON.stringify(value.Properties?.SourceArn).includes('/*/POST/v1/sessions'),
    );
    assert.ok(startPermission);
    assert.equal(startPermission[1].Condition, 'GatewayPathEnabled');

    const apiFunctions = [
      'StartSession',
      'GetSession',
      'GetDebrief',
      'ListTimeline',
      'GetPlayback',
      'EndSession',
      'ReleaseHint',
    ];
    for (const prefix of apiFunctions) {
      const fn = Object.entries(resources).find(
        ([id, value]) => id.startsWith(prefix) && value.Type === 'AWS::Lambda::Function',
      );
      assert.ok(fn, `Missing ${prefix} Lambda`);
      assert.deepEqual(fn[1].Properties?.Environment.Variables.PUBLIC_API_ALLOWED_ORIGIN, {
        Ref: 'PublicApiAllowedOrigin',
      });
      assert.deepEqual(fn[1].Properties?.Environment.Variables.COGNITO_USER_POOL_CLIENT_ID, {
        'Fn::If': ['ManagedCognitoIdentity', { Ref: client[0] }, { Ref: 'CognitoUserPoolClientId' }],
      });
    }
    const ticket = Object.entries(resources).find(
      ([id, value]) => id.startsWith('CreateTerminalTicket') && value.Type === 'AWS::Lambda::Function',
    );
    assert.ok(ticket);
    assert.deepEqual(ticket[1].Properties?.Environment.Variables.COGNITO_USER_POOL_CLIENT_ID, {
      'Fn::If': ['ManagedCognitoIdentity', { Ref: client[0] }, { Ref: 'CognitoUserPoolClientId' }],
    });
    const startFunction = Object.entries(resources).find(
      ([id, value]) => id.startsWith('StartSession') && value.Type === 'AWS::Lambda::Function',
    );
    assert.deepEqual(startFunction?.[1].Properties?.ReservedConcurrentExecutions, {
      'Fn::If': ['SessionAdmissionEnabled', { Ref: 'StartSessionBurstLimit' }, 0],
    });

    const [stage] = ofType('AWS::ApiGateway::Stage');
    assert.ok(stage);
    assert.ok(
      stage[1].Properties?.MethodSettings.some(
        (setting: Record<string, unknown>) =>
          setting.HttpMethod === 'POST' &&
          setting.ResourcePath === '/~1v1~1sessions' &&
          JSON.stringify(setting.ThrottlingBurstLimit) === JSON.stringify({ Ref: 'StartSessionBurstLimit' }) &&
          JSON.stringify(setting.ThrottlingRateLimit) === JSON.stringify({ Ref: 'StartSessionRateLimit' }),
      ),
    );
    const [deployment] = ofType('AWS::ApiGateway::Deployment');
    assert.ok(deployment);
    assert.equal(deployment[0], 'TerminalTicketApiDeploymentV13');
    const dependencies = [deployment[1].DependsOn].flat();
    for (const [id] of methods) assert.ok(dependencies.includes(id));

    for (const output of ['PublicApiAllowedOrigin', 'BrowserCallbackUrl', 'BrowserLogoutUrl']) {
      assert.equal(rendered.Outputs[output]?.Condition, 'GatewayPathEnabled');
    }
    assert.deepEqual(rendered.Outputs.CognitoUserPoolId, {
      Value: { 'Fn::Select': [1, { 'Fn::Split': ['/', { Ref: 'CognitoUserPoolArn' }] }] },
    });
    for (const output of ['ManagedCognitoUserPoolClientId', 'ManagedCognitoLoginHostname'])
      assert.equal(rendered.Outputs[output]?.Condition, 'ManagedCognitoIdentity');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
