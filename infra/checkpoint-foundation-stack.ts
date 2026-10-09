import { Aws, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  CfnSecurityGroup,
  CfnSecurityGroupIngress,
  CfnVPCEndpoint,
  IpAddresses,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { CfnCluster } from 'aws-cdk-lib/aws-ecs';
import { Repository, RepositoryEncryption, TagMutability, TagStatus } from 'aws-cdk-lib/aws-ecr';
import { FederatedPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const workloadSubnetName = 'workloads';
const vpcCidr = '10.42.0.0/24';
const vpcDnsResolverIpv4 = '10.42.0.2';

export class CheckpointFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    Tags.of(this).add('opsreplay:environment', 'checkpoint');
    Tags.of(this).add('opsreplay:managed-by', 'cdk');

    const s3PrefixListId = new CfnParameter(this, 'S3PrefixListId', {
      type: 'String',
      allowedPattern: 'pl-[0-9a-f]+',
      description: 'AWS-managed S3 prefix list for the deployment Region.',
    });
    const dynamoDbPrefixListId = new CfnParameter(this, 'DynamoDbPrefixListId', {
      type: 'String',
      allowedPattern: 'pl-[0-9a-f]+',
      description: 'AWS-managed DynamoDB prefix list for the deployment Region.',
    });
    const gitHubOidcProviderArn = new CfnParameter(this, 'GitHubOidcProviderArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com',
      description: 'Verified GitHub Actions OIDC provider ARN with the sts.amazonaws.com client ID.',
    });

    const vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr(vpcCidr),
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 26,
          name: workloadSubnetName,
          subnetType: SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    const workloadSubnets = vpc.selectSubnets({ subnetGroupName: workloadSubnetName });

    const endpointSecurityGroup = new CfnSecurityGroup(this, 'AwsInterfaceEndpointSecurityGroup', {
      vpcId: vpc.vpcId,
      groupDescription: 'Private AWS interface endpoints for checkpoint tasks.',
      securityGroupEgress: [
        {
          ipProtocol: 'icmp',
          fromPort: 252,
          toPort: 86,
          cidrIp: '255.255.255.255/32',
          description: 'Disallow all outbound traffic',
        },
      ],
    });
    const environmentSecurityGroup = new CfnSecurityGroup(this, 'EnvironmentSecurityGroup', {
      vpcId: vpc.vpcId,
      groupDescription: 'Checkpoint Challenge and monitor tasks. No direct inbound access.',
      securityGroupEgress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          destinationSecurityGroupId: endpointSecurityGroup.attrGroupId,
          description: 'ECR and CloudWatch Logs interface endpoints',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          destinationPrefixListId: s3PrefixListId.valueAsString,
          description: 'S3 gateway endpoint',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 53,
          toPort: 53,
          cidrIp: `${vpcDnsResolverIpv4}/32`,
          description: 'VPC DNS resolver',
        },
        {
          ipProtocol: 'udp',
          fromPort: 53,
          toPort: 53,
          cidrIp: `${vpcDnsResolverIpv4}/32`,
          description: 'VPC DNS resolver',
        },
      ],
    });
    new CfnSecurityGroupIngress(this, 'AwsInterfaceEndpointIngress', {
      groupId: endpointSecurityGroup.attrGroupId,
      sourceSecurityGroupId: environmentSecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      description: 'Checkpoint environment tasks',
    });

    for (const [name, service] of [
      ['S3Endpoint', 's3'],
      ['DynamoDbEndpoint', 'dynamodb'],
    ] as const) {
      new CfnVPCEndpoint(this, name, {
        vpcId: vpc.vpcId,
        vpcEndpointType: 'Gateway',
        serviceName: Fn.join('', ['com.amazonaws.', Aws.REGION, '.', service]),
        routeTableIds: workloadSubnets.subnets.map((subnet) => subnet.routeTable.routeTableId),
      });
    }
    for (const [name, service] of [
      ['EcrApiEndpoint', 'ecr.api'],
      ['EcrDockerEndpoint', 'ecr.dkr'],
      ['CloudWatchLogsEndpoint', 'logs'],
    ] as const) {
      new CfnVPCEndpoint(this, name, {
        vpcId: vpc.vpcId,
        vpcEndpointType: 'Interface',
        serviceName: Fn.join('', ['com.amazonaws.', Aws.REGION, '.', service]),
        privateDnsEnabled: true,
        securityGroupIds: [endpointSecurityGroup.attrGroupId],
        subnetIds: workloadSubnets.subnetIds,
      });
    }

    const cluster = new CfnCluster(this, 'Cluster', { clusterName: 'opsreplay-checkpoint' });
    const repository = (id: string, repositoryName: string) =>
      new Repository(this, id, {
        repositoryName,
        encryption: RepositoryEncryption.AES_256,
        imageScanOnPush: true,
        imageTagMutability: TagMutability.IMMUTABLE,
        lifecycleRules: [
          {
            maxImageCount: 5,
            tagStatus: TagStatus.UNTAGGED,
            description: 'Retain five untagged checkpoint images.',
          },
        ],
        removalPolicy: RemovalPolicy.DESTROY,
        emptyOnDelete: true,
      });
    const gatewayRepository = repository('GatewayRepository', 'opsreplay-gateway');
    const monitorRepository = repository('MonitorRepository', 'opsreplay/monitor');
    const challengeRepository = repository('ChallengeRepository', 'opsreplay/challenge-wrong-upstream-port');

    const imagePublisherRole = new Role(this, 'GitHubImagePublisherRole', {
      assumedBy: new FederatedPrincipal(
        gitHubOidcProviderArn.valueAsString,
        {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub':
              'repo:ehz0ah@130889443/OpsReplay@1378586293:environment:aws-checkpoint',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      description: 'Publishes immutable checkpoint images from the OpsReplay main branch.',
      maxSessionDuration: Duration.hours(1),
    });
    imagePublisherRole.addToPolicy(
      new PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    imagePublisherRole.addToPolicy(
      new PolicyStatement({
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:CompleteLayerUpload',
          'ecr:InitiateLayerUpload',
          'ecr:PutImage',
          'ecr:UploadLayerPart',
        ],
        resources: [
          gatewayRepository.repositoryArn,
          monitorRepository.repositoryArn,
          challengeRepository.repositoryArn,
        ],
      }),
    );

    const environmentLogs = new LogGroup(this, 'EnvironmentLogs', {
      logGroupName: '/opsreplay/checkpoint/environment',
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const executionRole = new Role(this, 'EnvironmentExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Pulls checkpoint environment images and writes monitor logs. Not available inside containers.',
    });
    executionRole.addToPolicy(
      new PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    executionRole.addToPolicy(
      new PolicyStatement({
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [monitorRepository.repositoryArn, challengeRepository.repositoryArn],
      }),
    );
    environmentLogs.grantWrite(executionRole);

    const outputs: Record<string, string> = {
      EnvironmentClusterArn: cluster.attrArn,
      EnvironmentSubnetIds: workloadSubnets.subnetIds.join(','),
      EnvironmentSecurityGroupIds: environmentSecurityGroup.attrGroupId,
      EnvironmentVpcId: vpc.vpcId,
      EnvironmentMonitorSecurityGroupId: environmentSecurityGroup.attrGroupId,
      AwsInterfaceEndpointSecurityGroupId: endpointSecurityGroup.attrGroupId,
      S3GatewayEndpointPrefixListId: s3PrefixListId.valueAsString,
      DynamoDbGatewayEndpointPrefixListId: dynamoDbPrefixListId.valueAsString,
      VpcDnsResolverIpv4: vpcDnsResolverIpv4,
      EnvironmentExecutionRoleArn: executionRole.roleArn,
      EnvironmentLogGroupName: environmentLogs.logGroupName,
      GatewayRepositoryUri: gatewayRepository.repositoryUri,
      MonitorRepositoryUri: monitorRepository.repositoryUri,
      ChallengeRepositoryUri: challengeRepository.repositoryUri,
      GitHubImagePublisherRoleArn: imagePublisherRole.roleArn,
    };
    for (const [name, value] of Object.entries(outputs)) new CfnOutput(this, name, { value });
  }
}
