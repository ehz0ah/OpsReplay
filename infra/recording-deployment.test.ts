import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SessionStartStack } from './session-start-stack.js';

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Condition?: string;
  DependsOn?: string | string[];
};

function synthesize() {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-gateway-cdk-'));
  const app = new App({ outdir: directory });
  const stack = new SessionStartStack(app, 'TestGateway');
  const template = Template.fromStack(stack);
  return {
    directory,
    template,
    rendered: template.toJSON() as {
      Parameters: Record<string, Record<string, unknown>>;
      Conditions: Record<string, unknown>;
      Rules: Record<string, unknown>;
      Resources: Record<string, Resource>;
      Outputs: Record<string, Record<string, unknown>>;
    },
  };
}

const ofType = (resources: Record<string, Resource>, type: string) =>
  Object.entries(resources).filter(([, resource]) => resource.Type === type);

test('the complete Gateway path is bounded, conditional, and private behind the ALB', () => {
  const { directory, template, rendered } = synthesize();
  try {
    assert.deepEqual(rendered.Parameters.EnableGatewayPath, {
      Type: 'String',
      Default: 'false',
      AllowedValues: ['false', 'true'],
      Description: 'Enable the complete checkpoint runtime while keeping new-session admission separately gated.',
    });
    assert.ok(rendered.Conditions.GatewayPathEnabled);
    assert.deepEqual(rendered.Parameters.EnvironmentSubnetIds, {
      Type: 'List<AWS::EC2::Subnet::Id>',
    });
    assert.equal(rendered.Parameters.GatewayDesiredCount?.Default, 1);
    assert.equal(rendered.Parameters.GatewayMaximumConcurrentRecordings?.Default, 16);
    assert.equal(rendered.Parameters.GatewayMaximumConcurrentRecordings?.MaxValue, 64);
    assert.equal(rendered.Parameters.TerminalTicketBurstLimit?.Default, 16);
    assert.equal(rendered.Parameters.TerminalTicketBurstLimit?.MaxValue, 256);
    assert.equal(rendered.Parameters.TerminalTicketRateLimit?.Default, 8);
    assert.equal(rendered.Parameters.TerminalTicketRateLimit?.MaxValue, 256);
    const allowedOriginsPattern = rendered.Parameters.TerminalAllowedOrigins?.AllowedPattern;
    assert.ok(typeof allowedOriginsPattern === 'string');
    const allowedOrigins = new RegExp(allowedOriginsPattern);
    for (const value of [
      '',
      'https://app.opsreplay.test',
      'http://localhost:3000',
      'https://app.opsreplay.test,http://localhost:3000',
    ]) {
      assert.match(value, allowedOrigins);
    }
    for (const value of [
      'ftp://app.opsreplay.test',
      'https://user@app.opsreplay.test',
      'https://app.opsreplay.test/path',
      'https://app.opsreplay.test:65536',
      'https://app.opsreplay.test,',
    ]) {
      assert.doesNotMatch(value, allowedOrigins);
    }
    assert.deepEqual(rendered.Rules.GatewayPathConfigurationRequiredWhenEnabled, {
      RuleCondition: { 'Fn::Equals': [{ Ref: 'EnableGatewayPath' }, 'true'] },
      Assertions: [
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'GatewayImageDigest' }, ''] }] },
          AssertDescription: 'GatewayImageDigest is required when EnableGatewayPath is true.',
        },
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'CloudFrontOriginPrefixListId' }, ''] }] },
          AssertDescription: 'CloudFrontOriginPrefixListId is required when EnableGatewayPath is true.',
        },
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'TerminalAllowedOrigins' }, ''] }] },
          AssertDescription: 'TerminalAllowedOrigins is required when EnableGatewayPath is true.',
        },
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'TerminalEdgeWebAclArn' }, ''] }] },
          AssertDescription: 'TerminalEdgeWebAclArn is required when EnableGatewayPath is true.',
        },
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'PublicApiAllowedOrigin' }, ''] }] },
          AssertDescription: 'PublicApiAllowedOrigin is required when EnableGatewayPath is true.',
        },
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'BrowserCallbackUrl' }, ''] }] },
          AssertDescription: 'BrowserCallbackUrl is required when EnableGatewayPath is true.',
        },
        {
          Assert: { 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'BrowserLogoutUrl' }, ''] }] },
          AssertDescription: 'BrowserLogoutUrl is required when EnableGatewayPath is true.',
        },
      ],
    });

    const [loadBalancer] = ofType(rendered.Resources, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    assert.ok(loadBalancer);
    assert.equal(loadBalancer[1].Condition, 'GatewayPathEnabled');
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      IpAddressType: 'ipv4',
      LoadBalancerAttributes: [
        { Key: 'idle_timeout.timeout_seconds', Value: '60' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
      ],
      Scheme: 'internal',
      SecurityGroups: [Match.anyValue()],
      Subnets: { Ref: 'EnvironmentSubnetIds' },
      Type: 'application',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [
        {
          Type: 'fixed-response',
          FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not found' },
        },
      ],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Priority: 1,
      Conditions: [{ Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/terminal'] } }],
      Actions: [{ Type: 'forward', TargetGroupArn: Match.anyValue() }],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 8080,
      Protocol: 'HTTP',
      ProtocolVersion: 'HTTP1',
      TargetType: 'ip',
      HealthCheckPath: '/healthz',
      HealthCheckPort: 'traffic-port',
      Matcher: { HttpCode: '200' },
      TargetGroupAttributes: Match.arrayWith([{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }]),
    });
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);

    const securityGroups = ofType(rendered.Resources, 'AWS::EC2::SecurityGroup');
    assert.equal(securityGroups.length, 2);
    const gatewayGroup = securityGroups.find(
      ([, group]) => group.Properties?.GroupDescription === 'Private OpsReplay Gateway tasks.',
    );
    const loadBalancerGroup = securityGroups.find(
      ([, group]) =>
        group.Properties?.GroupDescription === 'Private CloudFront origin for the OpsReplay terminal Gateway.',
    );
    assert.ok(gatewayGroup);
    assert.ok(loadBalancerGroup);
    assert.equal(loadBalancerGroup[1].Condition, 'GatewayPathEnabled');
    const gatewayEgress = gatewayGroup[1].Properties?.SecurityGroupEgress as Record<string, unknown>[];
    assert.equal(gatewayEgress.length, 6);
    assert.equal(
      gatewayEgress.some((rule) => rule.CidrIp === '0.0.0.0/0'),
      false,
    );
    assert.deepEqual(gatewayEgress, [
      {
        IpProtocol: 'tcp',
        FromPort: 9443,
        ToPort: 9443,
        DestinationSecurityGroupId: { Ref: 'EnvironmentMonitorSecurityGroupId' },
        Description: 'Authenticated monitor control',
      },
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        DestinationPrefixListId: { Ref: 'S3GatewayEndpointPrefixListId' },
        Description: 'S3 gateway endpoint',
      },
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        DestinationPrefixListId: { Ref: 'DynamoDbGatewayEndpointPrefixListId' },
        Description: 'DynamoDB gateway endpoint',
      },
      {
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        DestinationSecurityGroupId: { Ref: 'AwsInterfaceEndpointSecurityGroupId' },
        Description: 'ECR and CloudWatch Logs interface endpoints',
      },
      {
        IpProtocol: 'tcp',
        FromPort: 53,
        ToPort: 53,
        CidrIp: { 'Fn::Join': ['', [{ Ref: 'VpcDnsResolverIpv4' }, '/32']] },
        Description: 'VPC DNS resolver',
      },
      {
        IpProtocol: 'udp',
        FromPort: 53,
        ToPort: 53,
        CidrIp: { 'Fn::Join': ['', [{ Ref: 'VpcDnsResolverIpv4' }, '/32']] },
        Description: 'VPC DNS resolver',
      },
    ]);
    assert.deepEqual(loadBalancerGroup[1].Properties?.SecurityGroupIngress, [
      {
        IpProtocol: 'tcp',
        FromPort: 80,
        ToPort: 80,
        SourcePrefixListId: { Ref: 'CloudFrontOriginPrefixListId' },
        Description: 'CloudFront VPC origin HTTP and WebSocket traffic',
      },
    ]);
    assert.deepEqual(loadBalancerGroup[1].Properties?.SecurityGroupEgress, [
      {
        IpProtocol: 'tcp',
        FromPort: 8080,
        ToPort: 8080,
        DestinationSecurityGroupId: { 'Fn::GetAtt': [gatewayGroup[0], 'GroupId'] },
        Description: 'Terminal Gateway targets',
      },
    ]);
    template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
      GroupId: { 'Fn::GetAtt': [gatewayGroup[0], 'GroupId'] },
      DestinationSecurityGroupId: { Ref: 'EnvironmentMonitorSecurityGroupId' },
      IpProtocol: 'tcp',
      FromPort: 7681,
      ToPort: 7681,
    });
    for (const [, rule] of [
      ...ofType(rendered.Resources, 'AWS::EC2::SecurityGroupEgress'),
      ...ofType(rendered.Resources, 'AWS::EC2::SecurityGroupIngress').filter(([, resource]) =>
        [7681, 8080].includes(resource.Properties?.FromPort as number),
      ),
    ]) {
      assert.equal(rule.Condition, 'GatewayPathEnabled');
    }

    const [gatewayTask] = ofType(rendered.Resources, 'AWS::ECS::TaskDefinition');
    assert.ok(gatewayTask);
    assert.equal(gatewayTask[1].Condition, 'GatewayPathEnabled');
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'opsreplay-gateway',
      Cpu: '512',
      Memory: '1024',
      NetworkMode: 'awsvpc',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
      ContainerDefinitions: [
        Match.objectLike({
          Name: 'gateway',
          Essential: true,
          ReadonlyRootFilesystem: true,
          User: 'node',
          StopTimeout: 30,
          PortMappings: [{ Name: 'terminal-websocket', ContainerPort: 8080, Protocol: 'tcp' }],
          Environment: Match.arrayWith([
            { Name: 'GATEWAY_PORT', Value: '8080' },
            { Name: 'TERMINAL_ALLOWED_ORIGINS', Value: { Ref: 'TerminalAllowedOrigins' } },
            { Name: 'MAXIMUM_TERMINAL_CONNECTIONS', Value: '256' },
            { Name: 'MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS', Value: '64' },
            { Name: 'TERMINAL_PORT', Value: '7681' },
          ]),
        }),
      ],
    });
    const [gatewayService] = ofType(rendered.Resources, 'AWS::ECS::Service');
    assert.ok(gatewayService);
    assert.equal(gatewayService[1].Condition, 'GatewayPathEnabled');
    assert.ok([gatewayService[1].DependsOn].flat().includes('TerminalWebSocketRoute'));
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: { Ref: 'GatewayDesiredCount' },
      LaunchType: 'FARGATE',
      PlatformVersion: '1.4.0',
      EnableExecuteCommand: false,
      HealthCheckGracePeriodSeconds: 30,
      LoadBalancers: [{ ContainerName: 'gateway', ContainerPort: 8080, TargetGroupArn: Match.anyValue() }],
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'DISABLED',
          SecurityGroups: [Match.anyValue()],
          Subnets: { Ref: 'EnvironmentSubnetIds' },
        },
      },
    });
    for (const output of ['GatewayServiceName', 'TerminalLoadBalancerDnsName', 'TerminalTicketApiUrl']) {
      assert.equal(rendered.Outputs[output]?.Condition, 'GatewayPathEnabled');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal-ticket deployment is action-scoped, authenticated, throttled, and disabled by default', () => {
  const { directory, template, rendered } = synthesize();
  try {
    assert.equal(ofType(rendered.Resources, 'AWS::DynamoDB::Table').length, 0);
    assert.ok(rendered.Parameters.SessionTableStreamArn);
    assert.equal(rendered.Parameters.SessionTableName, undefined);
    assert.ok(rendered.Parameters.MonitorBootstrapBucketArn);
    assert.equal(rendered.Parameters.MonitorBootstrapBucketName, undefined);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Timeout: 10,
      MemorySize: 256,
      Environment: {
        Variables: Match.objectLike({
          SESSION_TABLE_NAME: Match.anyValue(),
          TERMINAL_GATEWAY_URL: {
            'Fn::If': [
              'GatewayPathEnabled',
              {
                'Fn::Join': ['', ['wss://', { 'Fn::GetAtt': ['TerminalDistribution', 'DomainName'] }, '/v1/terminal']],
              },
              '',
            ],
          },
        }),
      },
      ReservedConcurrentExecutions: {
        'Fn::If': ['GatewayPathEnabled', { Ref: 'TerminalTicketBurstLimit' }, 0],
      },
    });
    const policies = ofType(rendered.Resources, 'AWS::IAM::Policy');
    const statements = policies.flatMap(([, policy]) => {
      const document = policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] };
      return document.Statement;
    });
    assert.ok(
      statements.some(
        (statement) =>
          JSON.stringify(statement.Action) ===
            JSON.stringify(['dynamodb:GetItem', 'dynamodb:ConditionCheckItem', 'dynamodb:PutItem']) &&
          JSON.stringify(statement.Condition) ===
            JSON.stringify({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } }),
      ),
    );

    for (const type of [
      'AWS::ApiGateway::RestApi',
      'AWS::ApiGateway::Authorizer',
      'AWS::ApiGateway::Resource',
      'AWS::ApiGateway::Method',
      'AWS::ApiGateway::GatewayResponse',
      'AWS::ApiGateway::Deployment',
      'AWS::ApiGateway::Stage',
    ]) {
      const resources = ofType(rendered.Resources, type);
      assert.ok(resources.length > 0);
      for (const [, resource] of resources) assert.equal(resource.Condition, 'GatewayPathEnabled');
    }
    const [deployment] = ofType(rendered.Resources, 'AWS::ApiGateway::Deployment');
    const methods = ofType(rendered.Resources, 'AWS::ApiGateway::Method');
    const method = methods.find(([, resource]) => resource.Properties?.OperationName === 'createTerminalTicket');
    const gatewayResponses = ofType(rendered.Resources, 'AWS::ApiGateway::GatewayResponse');
    assert.ok(deployment);
    assert.ok(method);
    assert.equal(deployment[0], 'TerminalTicketApiDeploymentV12');
    assert.equal(gatewayResponses.length, 5);
    const deploymentDependencies = [deployment[1].DependsOn].flat();
    assert.ok(deploymentDependencies.includes(method[0]));
    for (const [logicalId] of gatewayResponses) assert.ok(deploymentDependencies.includes(logicalId));
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Type: 'COGNITO_USER_POOLS',
      IdentitySource: 'method.request.header.Authorization',
      ProviderARNs: [{ Ref: 'CognitoUserPoolArn' }],
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      AuthorizationType: 'COGNITO_USER_POOLS',
      ApiKeyRequired: false,
      OperationName: 'createTerminalTicket',
      Integration: Match.objectLike({ Type: 'AWS_PROXY', IntegrationHttpMethod: 'POST', TimeoutInMillis: 8000 }),
    });
    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'checkpoint',
      MethodSettings: Match.arrayWith([
        {
          HttpMethod: 'POST',
          ResourcePath: '/~1v1~1sessions~1{id}~1end',
          CachingEnabled: false,
          DataTraceEnabled: false,
          MetricsEnabled: true,
          ThrottlingBurstLimit: 8,
          ThrottlingRateLimit: 4,
        },
        {
          HttpMethod: 'GET',
          ResourcePath: '/~1v1~1sessions~1{id}',
          CachingEnabled: false,
          DataTraceEnabled: false,
          MetricsEnabled: true,
          ThrottlingBurstLimit: { Ref: 'SessionStatusBurstLimit' },
          ThrottlingRateLimit: { Ref: 'SessionStatusRateLimit' },
        },
        {
          HttpMethod: 'POST',
          ResourcePath: '/~1v1~1sessions~1{id}~1terminal-tickets',
          CachingEnabled: false,
          DataTraceEnabled: false,
          MetricsEnabled: true,
          ThrottlingBurstLimit: { Ref: 'TerminalTicketBurstLimit' },
          ThrottlingRateLimit: { Ref: 'TerminalTicketRateLimit' },
        },
      ]),
    });
    const expectedGatewayResponses = {
      THROTTLED: [
        '429',
        '{"code":"LIMIT_EXCEEDED","message":"Too many session requests. Try again.","requestId":"$context.requestId"}',
      ],
      UNAUTHORIZED: [
        '401',
        '{"code":"UNAUTHENTICATED","message":"Sign in before accessing a session.","requestId":"$context.requestId"}',
      ],
      ACCESS_DENIED: [
        '403',
        '{"code":"ACCESS_DENIED","message":"Access to this session is denied.","requestId":"$context.requestId"}',
      ],
      DEFAULT_4XX: [
        '400',
        '{"code":"INVALID_REQUEST","message":"The session request was rejected.","requestId":"$context.requestId"}',
      ],
      DEFAULT_5XX: [
        '500',
        '{"code":"INTERNAL_ERROR","message":"The session request could not be completed. Try again.","requestId":"$context.requestId"}',
      ],
    } as const;
    for (const [, response] of gatewayResponses) {
      const responseType = response.Properties?.ResponseType as keyof typeof expectedGatewayResponses;
      const expected = expectedGatewayResponses[responseType];
      assert.ok(expected, `Unexpected GatewayResponse ${String(responseType)}`);
      assert.equal(response.Properties?.StatusCode, expected[0]);
      assert.deepEqual(response.Properties?.ResponseParameters, {
        'gatewayresponse.header.Access-Control-Allow-Origin': {
          'Fn::Join': ['', ["'", { Ref: 'PublicApiAllowedOrigin' }, "'"]],
        },
        'gatewayresponse.header.Cache-Control': "'no-store'",
        'gatewayresponse.header.Content-Type': "'application/json'",
        'gatewayresponse.header.Vary': "'Origin'",
      });
      assert.deepEqual(response.Properties?.ResponseTemplates, { 'application/json': expected[1] });
    }
    const apiPermissions = ofType(rendered.Resources, 'AWS::Lambda::Permission').filter(
      ([, resource]) => resource.Properties?.Principal === 'apigateway.amazonaws.com',
    );
    assert.equal(apiPermissions.length, 18);
    const ticketPermission = apiPermissions.find(([, resource]) =>
      JSON.stringify(resource.Properties?.SourceArn).includes('POST/v1/sessions/*/terminal-tickets'),
    );
    assert.ok(ticketPermission);
    assert.equal(ticketPermission[1].Condition, 'GatewayPathEnabled');
    assert.match(JSON.stringify(ticketPermission[1].Properties?.SourceArn), /POST\/v1\/sessions\/\*\/terminal-tickets/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the combined Gateway service uses imported recording storage with least privilege', () => {
  const { directory, template, rendered } = synthesize();
  try {
    assert.equal(ofType(rendered.Resources, 'AWS::DynamoDB::Table').length, 0);
    assert.equal(ofType(rendered.Resources, 'AWS::S3::Bucket').length, 0);
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: { 'Fn::If': ['GatewayPathEnabled', 4, 0] },
      Environment: { Variables: { SESSION_TABLE_NAME: Match.anyValue() } },
    });
    template.hasResourceProperties('AWS::Events::Rule', {
      State: { 'Fn::If': ['GatewayPathEnabled', 'ENABLED', 'DISABLED'] },
    });

    const statements = ofType(rendered.Resources, 'AWS::IAM::Policy').flatMap(([, policy]) => {
      const document = policy.Properties?.PolicyDocument as { Statement: Record<string, unknown>[] };
      return document.Statement;
    });
    assert.ok(
      statements.some(
        (statement) =>
          JSON.stringify(statement.Action) ===
            JSON.stringify([
              'dynamodb:BatchGetItem',
              'dynamodb:ConditionCheckItem',
              'dynamodb:DeleteItem',
              'dynamodb:GetItem',
              'dynamodb:PutItem',
              'dynamodb:Query',
              'dynamodb:TransactGetItems',
              'dynamodb:UpdateItem',
            ]) &&
          JSON.stringify(statement.Condition) ===
            JSON.stringify({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } }),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.Action === 'dynamodb:Query' && JSON.stringify(statement.Resource).includes('unfinished-work'),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          JSON.stringify(statement.Action) === JSON.stringify(['s3:PutObject', 's3:PutObjectTagging']) &&
          JSON.stringify(statement.Resource).includes('/sessions/*') &&
          JSON.stringify(statement.Condition) ===
            JSON.stringify({
              StringEquals: {
                's3:RequestObjectTag/opsreplay-retention': ['provisional', 'sealed'],
              },
              'ForAllValues:StringEquals': { 's3:RequestObjectTagKeys': ['opsreplay-retention'] },
            }),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.Effect === 'Deny' &&
          statement.Action === 's3:PutObjectTagging' &&
          JSON.stringify(statement.Resource).includes('/sessions/*') &&
          JSON.stringify(statement.Condition) ===
            JSON.stringify({ Null: { 's3:ExistingObjectTag/opsreplay-retention': 'false' } }),
      ),
    );
    assert.ok(
      statements.some(
        (statement) =>
          statement.Action === 's3:GetObject' &&
          JSON.stringify(statement.Resource).includes('/sessions/*/terminal/*/live/*'),
      ),
    );
    assert.equal(
      statements.some((statement) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        return (
          JSON.stringify(statement.Resource).includes('Recordings') &&
          (actions.some(
            (action) => typeof action === 'string' && ['s3:ListBucket', 's3:DeleteObject'].includes(action),
          ) ||
            (actions.includes('s3:GetObject') &&
              !JSON.stringify(statement.Resource).includes('/sessions/*/terminal/*/live/*') &&
              !JSON.stringify(statement.Resource).includes('/sessions/*/metrics/*/sealed/*') &&
              !JSON.stringify(statement.Resource).includes('/sessions/*/playback/*') &&
              !JSON.stringify(statement.Resource).includes('/sessions/*/captures/*')))
        );
      }),
      false,
    );
    for (const [, role] of ofType(rendered.Resources, 'AWS::IAM::Role')) {
      assert.equal(role.Properties?.ManagedPolicyArns, undefined);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
