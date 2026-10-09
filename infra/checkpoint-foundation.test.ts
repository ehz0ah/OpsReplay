import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CheckpointFoundationStack } from './checkpoint-foundation-stack.js';

interface Resource {
  Type: string;
  Properties?: Record<string, unknown>;
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
}

function synthesize() {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-checkpoint-foundation-'));
  const app = new App({ outdir: directory });
  const stack = new CheckpointFoundationStack(app, 'TestCheckpointFoundation');
  const template = Template.fromStack(stack);
  return {
    directory,
    template,
    rendered: template.toJSON() as {
      Parameters: Record<string, Record<string, unknown>>;
      Resources: Record<string, Resource>;
      Outputs: Record<string, Record<string, unknown>>;
    },
  };
}

test('checkpoint workloads have private endpoint-only network access', () => {
  const { directory, template, rendered } = synthesize();
  try {
    assert.deepEqual(rendered.Parameters.S3PrefixListId, {
      Type: 'String',
      AllowedPattern: 'pl-[0-9a-f]+',
      Description: 'AWS-managed S3 prefix list for the deployment Region.',
    });
    assert.deepEqual(rendered.Parameters.DynamoDbPrefixListId, {
      Type: 'String',
      AllowedPattern: 'pl-[0-9a-f]+',
      Description: 'AWS-managed DynamoDB prefix list for the deployment Region.',
    });
    assert.deepEqual(rendered.Parameters.GitHubOidcProviderArn, {
      Type: 'String',
      AllowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com',
      Description: 'Verified GitHub Actions OIDC provider ARN with the sts.amazonaws.com client ID.',
    });

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 1);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::EIP', 0);
    template.hasResourceProperties('AWS::EC2::Subnet', {
      CidrBlock: '10.42.0.0/26',
      MapPublicIpOnLaunch: false,
    });

    const endpoints = Object.values(rendered.Resources).filter((resource) => resource.Type === 'AWS::EC2::VPCEndpoint');
    assert.equal(endpoints.length, 5);
    assert.equal(endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Gateway').length, 2);
    assert.equal(endpoints.filter((endpoint) => endpoint.Properties?.VpcEndpointType === 'Interface').length, 3);
    assert.deepEqual(
      endpoints
        .map((endpoint) => {
          const serviceName = endpoint.Properties?.ServiceName as { 'Fn::Join': [string, unknown[]] };
          return serviceName['Fn::Join'][1].at(-1);
        })
        .sort(),
      ['.dynamodb', '.ecr.api', '.ecr.dkr', '.logs', '.s3'],
    );
    for (const endpoint of endpoints.filter((item) => item.Properties?.VpcEndpointType === 'Interface')) {
      const properties = endpoint.Properties;
      assert.ok(properties);
      assert.equal(properties.PrivateDnsEnabled, true);
      assert.equal((properties.SubnetIds as unknown[]).length, 1);
      assert.equal((properties.SecurityGroupIds as unknown[]).length, 1);
    }

    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
    template.resourceCountIs('AWS::EC2::SecurityGroupEgress', 0);
    const securityGroupEntries = Object.entries(rendered.Resources).filter(
      ([, resource]) => resource.Type === 'AWS::EC2::SecurityGroup',
    );
    const endpointSecurityGroup = securityGroupEntries.find(
      ([, group]) => group.Properties?.GroupDescription === 'Private AWS interface endpoints for checkpoint tasks.',
    );
    const environmentSecurityGroup = securityGroupEntries.find(
      ([, group]) =>
        group.Properties?.GroupDescription === 'Checkpoint Challenge and monitor tasks. No direct inbound access.',
    );
    assert.ok(endpointSecurityGroup);
    assert.ok(environmentSecurityGroup);
    const ingress = Object.values(rendered.Resources).find(
      (resource) => resource.Type === 'AWS::EC2::SecurityGroupIngress',
    );
    assert.ok(ingress?.Properties);
    assert.deepEqual(ingress.Properties, {
      Description: 'Checkpoint environment tasks',
      FromPort: 443,
      GroupId: { 'Fn::GetAtt': [endpointSecurityGroup[0], 'GroupId'] },
      IpProtocol: 'tcp',
      SourceSecurityGroupId: { 'Fn::GetAtt': [environmentSecurityGroup[0], 'GroupId'] },
      ToPort: 443,
    });
    const environmentEgress = environmentSecurityGroup[1].Properties?.SecurityGroupEgress as Record<string, unknown>[];
    assert.equal(environmentEgress.length, 4);
    assert.ok(
      environmentEgress.some(
        (rule) =>
          rule.Description === 'S3 gateway endpoint' &&
          JSON.stringify(rule.DestinationPrefixListId) === JSON.stringify({ Ref: 'S3PrefixListId' }),
      ),
    );
    assert.ok(
      environmentEgress.some(
        (rule) => rule.Description === 'ECR and CloudWatch Logs interface endpoints' && rule.ToPort === 443,
      ),
    );
    assert.deepEqual(
      environmentEgress
        .filter((rule) => rule.Description === 'VPC DNS resolver')
        .map((rule) => rule.IpProtocol)
        .sort(),
      ['tcp', 'udp'],
    );
    const resolverIpv4 = rendered.Outputs.VpcDnsResolverIpv4?.Value;
    assert.equal(resolverIpv4, '10.42.0.2');
    for (const rule of environmentEgress.filter((item) => item.Description === 'VPC DNS resolver')) {
      assert.equal(rule.CidrIp, '10.42.0.2/32');
    }

    const securityGroupRules = securityGroupEntries.flatMap(([, resource]) => [
      resource.Properties,
      ...((resource.Properties?.SecurityGroupEgress as object[]) ?? []),
    ]);
    assert.equal(
      securityGroupRules.some((rule) => (rule as Record<string, unknown> | undefined)?.CidrIp === '0.0.0.0/0'),
      false,
    );
    template.resourceCountIs('AWS::ECS::Cluster', 1);

    const allowedResourceTypes = new Set([
      'AWS::EC2::RouteTable',
      'AWS::EC2::SecurityGroup',
      'AWS::EC2::SecurityGroupIngress',
      'AWS::EC2::Subnet',
      'AWS::EC2::SubnetRouteTableAssociation',
      'AWS::EC2::VPC',
      'AWS::EC2::VPCEndpoint',
      'AWS::ECR::Repository',
      'AWS::ECS::Cluster',
      'AWS::IAM::Policy',
      'AWS::IAM::Role',
      'AWS::Logs::LogGroup',
    ]);
    for (const resource of Object.values(rendered.Resources)) {
      assert.ok(allowedResourceTypes.has(resource.Type), `Unexpected checkpoint resource: ${resource.Type}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('checkpoint repositories and execution permissions are bounded and disposable', () => {
  const { directory, template, rendered } = synthesize();
  try {
    const repositoryEntries = Object.entries(rendered.Resources).filter(
      ([, resource]) => resource.Type === 'AWS::ECR::Repository',
    );
    assert.equal(repositoryEntries.length, 3);
    assert.deepEqual(
      repositoryEntries.map(([, repository]) => repository.Properties?.RepositoryName).sort(),
      ['opsreplay-gateway', 'opsreplay/monitor', 'opsreplay/challenge-wrong-upstream-port'].sort(),
    );
    for (const [, repository] of repositoryEntries) {
      const properties = repository.Properties;
      assert.ok(properties);
      assert.equal(properties.EmptyOnDelete, true);
      assert.equal(properties.ImageTagMutability, 'IMMUTABLE');
      assert.deepEqual(properties.ImageScanningConfiguration, { ScanOnPush: true });
      assert.equal(repository.DeletionPolicy, 'Delete');
      assert.equal(repository.UpdateReplacePolicy, 'Delete');
      const lifecycle = JSON.parse(
        String((properties.LifecyclePolicy as Record<string, unknown>).LifecyclePolicyText),
      ) as {
        rules: { selection: { countNumber: number; countType: string; tagStatus: string } }[];
      };
      assert.deepEqual(lifecycle.rules[0]?.selection, {
        countNumber: 5,
        countType: 'imageCountMoreThan',
        tagStatus: 'untagged',
      });
    }

    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);

    template.resourceCountIs('AWS::IAM::Role', 2);
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          },
        ],
        Version: '2012-10-17',
      },
    });
    const roleEntries = Object.entries(rendered.Resources).filter(([, resource]) => resource.Type === 'AWS::IAM::Role');
    const executionRoleEntry = roleEntries.find(
      ([, role]) =>
        (role.Properties?.AssumeRolePolicyDocument as { Statement?: { Action?: string }[] })?.Statement?.[0]?.Action ===
        'sts:AssumeRole',
    );
    const publisherRoleEntry = roleEntries.find(
      ([, role]) =>
        (role.Properties?.AssumeRolePolicyDocument as { Statement?: { Action?: string }[] })?.Statement?.[0]?.Action ===
        'sts:AssumeRoleWithWebIdentity',
    );
    assert.ok(executionRoleEntry);
    assert.ok(publisherRoleEntry);
    assert.equal(executionRoleEntry[1].Properties?.ManagedPolicyArns, undefined);
    assert.equal(publisherRoleEntry[1].Properties?.ManagedPolicyArns, undefined);
    assert.deepEqual(publisherRoleEntry[1].Properties?.AssumeRolePolicyDocument, {
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
          Principal: {
            Federated: { Ref: 'GitHubOidcProviderArn' },
          },
        },
      ],
      Version: '2012-10-17',
    });

    const policyEntries = Object.values(rendered.Resources).filter((resource) => resource.Type === 'AWS::IAM::Policy');
    assert.equal(policyEntries.length, 2);
    const executionPolicy = policyEntries.find((policy) =>
      (policy.Properties?.Roles as { Ref?: string }[])?.some((role) => role.Ref === executionRoleEntry[0]),
    );
    const publisherPolicy = policyEntries.find((policy) =>
      (policy.Properties?.Roles as { Ref?: string }[])?.some((role) => role.Ref === publisherRoleEntry[0]),
    );
    assert.ok(executionPolicy?.Properties);
    assert.ok(publisherPolicy?.Properties);
    const statements = (executionPolicy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] })
      .Statement;
    assert.deepEqual(
      statements.map((statement) => statement.Action),
      [
        'ecr:GetAuthorizationToken',
        ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        ['logs:CreateLogStream', 'logs:PutLogEvents'],
      ],
    );
    assert.equal(statements[0]?.Resource, '*');
    const repositoryArn = (name: string) => {
      const entry = repositoryEntries.find(([, repository]) => repository.Properties?.RepositoryName === name);
      assert.ok(entry);
      return { 'Fn::GetAtt': [entry[0], 'Arn'] };
    };
    assert.deepEqual(statements[1]?.Resource, [
      repositoryArn('opsreplay/monitor'),
      repositoryArn('opsreplay/challenge-wrong-upstream-port'),
    ]);
    const environmentLogGroupId = expectStringResourceId(
      rendered.Resources,
      'AWS::Logs::LogGroup',
      (resource) => resource.Properties?.LogGroupName === '/opsreplay/checkpoint/environment',
    );
    assert.deepEqual(statements[2]?.Resource, { 'Fn::GetAtt': [environmentLogGroupId, 'Arn'] });

    const publisherStatements = (publisherPolicy.Properties.PolicyDocument as { Statement: Record<string, unknown>[] })
      .Statement;
    assert.deepEqual(
      publisherStatements.map((statement) => statement.Action),
      [
        'ecr:GetAuthorizationToken',
        [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
      ],
    );
    assert.equal(publisherStatements[0]?.Resource, '*');
    assert.deepEqual(publisherStatements[1]?.Resource, [
      repositoryArn('opsreplay-gateway'),
      repositoryArn('opsreplay/monitor'),
      repositoryArn('opsreplay/challenge-wrong-upstream-port'),
    ]);

    template.hasResource('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
      Properties: { LogGroupName: '/opsreplay/checkpoint/environment', RetentionInDays: 7 },
    });
    for (const type of [
      'AWS::ECS::Service',
      'AWS::ECS::TaskDefinition',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::Lambda::Function',
      'AWS::ApiGateway::RestApi',
    ]) {
      template.resourceCountIs(type, 0);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function expectStringResourceId(
  resources: Record<string, Resource>,
  type: string,
  predicate: (resource: Resource) => boolean = () => true,
): string {
  const entry = Object.entries(resources).find(([, resource]) => resource.Type === type && predicate(resource));
  assert.ok(entry);
  return entry[0];
}

test('checkpoint outputs match the existing application-stack deployment inputs', () => {
  const { directory, rendered } = synthesize();
  try {
    assert.deepEqual(Object.keys(rendered.Outputs).sort(), [
      'AwsInterfaceEndpointSecurityGroupId',
      'ChallengeRepositoryUri',
      'DynamoDbGatewayEndpointPrefixListId',
      'EnvironmentClusterArn',
      'EnvironmentExecutionRoleArn',
      'EnvironmentLogGroupName',
      'EnvironmentMonitorSecurityGroupId',
      'EnvironmentSecurityGroupIds',
      'EnvironmentSubnetIds',
      'EnvironmentVpcId',
      'GatewayRepositoryUri',
      'GitHubImagePublisherRoleArn',
      'MonitorRepositoryUri',
      'S3GatewayEndpointPrefixListId',
      'VpcDnsResolverIpv4',
    ]);
    assert.deepEqual(rendered.Outputs.S3GatewayEndpointPrefixListId, { Value: { Ref: 'S3PrefixListId' } });
    assert.deepEqual(rendered.Outputs.DynamoDbGatewayEndpointPrefixListId, {
      Value: { Ref: 'DynamoDbPrefixListId' },
    });
    assert.deepEqual(rendered.Outputs.EnvironmentSecurityGroupIds, rendered.Outputs.EnvironmentMonitorSecurityGroupId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
