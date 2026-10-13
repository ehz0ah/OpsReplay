import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

type Parameters = Record<string, string | number | string[]>;
type TemplateValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function evaluate(value: TemplateValue, conditions: Record<string, TemplateValue>, parameters: Parameters): unknown {
  if (Array.isArray(value)) return value.map((item) => evaluate(item as TemplateValue, conditions, parameters));
  if (value === null || typeof value !== 'object') return value;
  if ('Ref' in value) return parameters[value.Ref as string];
  if ('Fn::Equals' in value) {
    const [left, right] = value['Fn::Equals'] as TemplateValue[];
    return evaluate(left!, conditions, parameters) === evaluate(right!, conditions, parameters);
  }
  if ('Fn::And' in value)
    return (value['Fn::And'] as TemplateValue[]).every((item) => evaluate(item, conditions, parameters) === true);
  if ('Fn::Not' in value) {
    const [item] = value['Fn::Not'] as TemplateValue[];
    return evaluate(item!, conditions, parameters) !== true;
  }
  if ('Fn::If' in value) {
    const [condition, whenTrue, whenFalse] = value['Fn::If'] as [string, TemplateValue, TemplateValue];
    return evaluate(conditions[condition]!, conditions, parameters) === true
      ? evaluate(whenTrue, conditions, parameters)
      : evaluate(whenFalse, conditions, parameters);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, evaluate(item as TemplateValue, conditions, parameters)]),
  );
}

function rulePasses(
  rule: { RuleCondition?: TemplateValue; Assertions: { Assert: TemplateValue }[] },
  conditions: Record<string, TemplateValue>,
  parameters: Parameters,
): boolean {
  if (rule.RuleCondition !== undefined && evaluate(rule.RuleCondition, conditions, parameters) !== true) return true;
  return rule.Assertions.every(({ Assert }) => evaluate(Assert, conditions, parameters) === true);
}

test('checkpoint activation has inactive, runtime-only, and runtime-plus-admission states', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-activation-'));
  try {
    const rendered = Template.fromStack(
      new SessionStartStack(new App({ outdir: directory }), 'TestActivation'),
    ).toJSON() as {
      Parameters: Record<string, Record<string, unknown>>;
      Conditions: Record<string, TemplateValue>;
      Rules: Record<string, { RuleCondition?: TemplateValue; Assertions: { Assert: TemplateValue }[] }>;
      Resources: Record<string, { Type: string; Properties: Record<string, TemplateValue> }>;
    };
    assert.deepEqual(rendered.Parameters.EnableSessionAdmission, {
      Type: 'String',
      Default: 'false',
      AllowedValues: ['false', 'true'],
      Description: 'Permit new session starts only after the complete checkpoint runtime is enabled and verified.',
    });
    assert.deepEqual(rendered.Conditions.SessionAdmissionEnabled, {
      'Fn::And': [
        { 'Fn::Equals': [{ Ref: 'EnableGatewayPath' }, 'true'] },
        { 'Fn::Equals': [{ Ref: 'EnableSessionAdmission' }, 'true'] },
      ],
    });
    assert.deepEqual(rendered.Conditions.ManagedCognitoIdentity, {
      'Fn::Equals': [{ Ref: 'CognitoIdentityMode' }, 'managed'],
    });

    const functionConcurrency = (prefix: string, parameters: Parameters) => {
      const fn = Object.entries(rendered.Resources).find(
        ([id, resource]) => id.startsWith(prefix) && resource.Type === 'AWS::Lambda::Function',
      );
      assert.ok(fn, `Missing ${prefix} Lambda`);
      return evaluate(fn[1].Properties.ReservedConcurrentExecutions!, rendered.Conditions, parameters);
    };
    const inactive = {
      EnableGatewayPath: 'false',
      EnableSessionAdmission: 'false',
      StartSessionBurstLimit: 3,
      TerminalTicketBurstLimit: 4,
      SessionStatusBurstLimit: 5,
    };
    const runtimeOnly = { ...inactive, EnableGatewayPath: 'true' };
    const open = { ...runtimeOnly, EnableSessionAdmission: 'true' };
    const runtimeActions = [
      'CreateTerminalTicket',
      'GetSession',
      'GetDebrief',
      'ListTimeline',
      'GetPlayback',
      'EndSession',
      'ReleaseHint',
      'ReconcileSession',
      'SweepSessions',
      'PublishRecordingWork',
    ];
    for (const action of ['StartSession', ...runtimeActions, 'ExpireProvisioning'])
      assert.equal(functionConcurrency(action, inactive), 0, `${action} must be inactive by default`);
    assert.equal(functionConcurrency('StartSession', runtimeOnly), 0);
    assert.equal(functionConcurrency('ExpireProvisioning', runtimeOnly), 0);
    for (const action of runtimeActions)
      assert.ok((functionConcurrency(action, runtimeOnly) as number) > 0, `${action} must run in runtime-only mode`);
    assert.equal(functionConcurrency('StartSession', open), 3);
    assert.equal(functionConcurrency('ExpireProvisioning', open), 0);
    for (const action of runtimeActions)
      assert.equal(functionConcurrency(action, open), functionConcurrency(action, runtimeOnly), action);

    const totalReservedConcurrency = (parameters: Parameters) =>
      ['StartSession', ...runtimeActions, 'ExpireProvisioning'].reduce(
        (total, action) => total + Number(functionConcurrency(action, parameters)),
        0,
      );
    const defaultRuntime = {
      EnableGatewayPath: 'true',
      EnableSessionAdmission: 'false',
      StartSessionBurstLimit: rendered.Parameters.StartSessionBurstLimit!.Default as number,
      TerminalTicketBurstLimit: rendered.Parameters.TerminalTicketBurstLimit!.Default as number,
      SessionStatusBurstLimit: rendered.Parameters.SessionStatusBurstLimit!.Default as number,
    };
    assert.equal(totalReservedConcurrency(defaultRuntime), 61);
    assert.equal(totalReservedConcurrency({ ...defaultRuntime, EnableSessionAdmission: 'true' }), 69);

    const stream = Object.values(rendered.Resources).find(
      (resource) => resource.Type === 'AWS::Lambda::EventSourceMapping',
    );
    assert.ok(stream);
    assert.equal(evaluate(stream.Properties.Enabled!, rendered.Conditions, inactive), false);
    assert.equal(evaluate(stream.Properties.Enabled!, rendered.Conditions, runtimeOnly), true);
    for (const prefix of ['LifecycleSweep', 'LifecycleTaskStopped', 'RecordRunningEnvironmentTask']) {
      const rule = Object.entries(rendered.Resources).find(
        ([id, resource]) => id.startsWith(prefix) && resource.Type === 'AWS::Events::Rule',
      );
      assert.ok(rule, `Missing ${prefix} rule`);
      assert.equal(evaluate(rule[1].Properties.State!, rendered.Conditions, inactive), 'DISABLED');
      assert.equal(evaluate(rule[1].Properties.State!, rendered.Conditions, runtimeOnly), 'ENABLED');
    }

    const admissionOnly = { ...inactive, EnableSessionAdmission: 'true' };
    const admissionRule = rendered.Rules.SessionAdmissionRequiresGatewayPath;
    assert.ok(admissionRule);
    assert.equal(rulePasses(admissionRule, rendered.Conditions, admissionOnly), false);
    assert.equal(rulePasses(admissionRule, rendered.Conditions, runtimeOnly), true);
    assert.equal(rulePasses(admissionRule, rendered.Conditions, open), true);

    const required: Parameters = {
      ...runtimeOnly,
      GatewayImageDigest: `sha256:${'a'.repeat(64)}`,
      CloudFrontOriginPrefixListId: 'pl-12345678',
      TerminalAllowedOrigins: 'https://app.opsreplay.test',
      TerminalEdgeWebAclArn: 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/test/12345678',
      PublicApiAllowedOrigin: 'https://app.opsreplay.test',
      BrowserCallbackUrl: 'https://app.opsreplay.test/auth/callback',
      BrowserLogoutUrl: 'https://app.opsreplay.test/',
      CognitoIdentityMode: 'external',
      CognitoUserPoolArn: 'arn:aws:cognito-idp:ap-southeast-1:111111111111:userpool/test',
      CognitoUserPoolClientId: 'client',
      CognitoLoginHostname: 'opsreplay.auth.ap-southeast-1.amazoncognito.com',
      CognitoDomainPrefix: '',
    };
    const runtimeRule = rendered.Rules.GatewayPathConfigurationRequiredWhenEnabled;
    assert.ok(runtimeRule);
    assert.equal(rulePasses(runtimeRule, rendered.Conditions, required), true);
    for (const parameter of [
      'GatewayImageDigest',
      'CloudFrontOriginPrefixListId',
      'TerminalAllowedOrigins',
      'TerminalEdgeWebAclArn',
      'PublicApiAllowedOrigin',
      'BrowserCallbackUrl',
      'BrowserLogoutUrl',
    ]) {
      assert.equal(
        rulePasses(runtimeRule, rendered.Conditions, {
          ...required,
          [parameter]: '',
        }),
        false,
        parameter,
      );
    }
    const externalIdentityRule = rendered.Rules.ExternalCognitoConfigurationRequired;
    assert.ok(externalIdentityRule);
    assert.equal(rulePasses(externalIdentityRule, rendered.Conditions, required), true);
    for (const parameter of ['CognitoUserPoolArn', 'CognitoUserPoolClientId', 'CognitoLoginHostname']) {
      assert.equal(
        rulePasses(externalIdentityRule, rendered.Conditions, {
          ...required,
          [parameter]: '',
        }),
        false,
        parameter,
      );
    }

    const admissionReferences = JSON.stringify(rendered.Resources).match(/SessionAdmissionEnabled/g) ?? [];
    assert.equal(admissionReferences.length, 1, 'Admission must control only the start Lambda.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
