import { fileURLToPath } from 'node:url';
import {
  ArnFormat,
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule as CloudFormationRule,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import {
  CfnAuthorizer,
  CfnDeployment,
  CfnGatewayResponse,
  CfnMethod,
  CfnResource as ApiGatewayResource,
  CfnRestApi,
  CfnStage,
} from 'aws-cdk-lib/aws-apigateway';
import { CfnUserPoolClient, CfnUserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { CachePolicy, CfnDistribution, CfnOriginRequestPolicy, CfnVpcOrigin } from 'aws-cdk-lib/aws-cloudfront';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Alarm, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnSecurityGroup, CfnSecurityGroupEgress, CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import { CfnService, CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { CfnListener, CfnListenerRule, CfnLoadBalancer, CfnTargetGroup } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnRule, Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, CfnEventSourceMapping, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsDestination } from 'aws-cdk-lib/aws-lambda-destinations';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { unfinishedWorkIndex } from '../packages/contracts/private/recording-work.js';
import { lifecycleHintPrefix } from '../packages/contracts/private/lifecycle-hint.js';
import { recordingRetention } from '../packages/contracts/private/recording-retention.js';

const gatewayPort = 8080;
const terminalPort = 7681;
const maximumTerminalConnections = 256;
const maximumPendingTerminalAuthentications = 64;
const terminalTicketApiDeploymentVersion = 8;
const reconcileSessionConcurrency = 4;
const sweepSessionsConcurrency = 1;
const ownerEndConcurrency = 4;
const hintReleaseConcurrency = 4;
const resultReadConcurrency = 4;
const terminalOriginHostPattern =
  '(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)';
const terminalOriginPortPattern =
  '(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?';
const terminalOriginPattern = `https?://${terminalOriginHostPattern}${terminalOriginPortPattern}`;
const terminalAllowedOriginsPattern = `^(?:${terminalOriginPattern}(?:,${terminalOriginPattern}){0,15})?$`;
const publicApiOriginPattern = `^(?:https://${terminalOriginHostPattern}${terminalOriginPortPattern}|http://localhost${terminalOriginPortPattern})$`;
const browserRedirectPattern = `(?:https://${terminalOriginHostPattern}${terminalOriginPortPattern}|http://localhost${terminalOriginPortPattern})(?:/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?`;
const cognitoLoginHostnamePattern =
  '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\\.auth\\.[a-z0-9-]+\\.amazoncognito\\.com$';

export class SessionStartStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const clusterArn = new CfnParameter(this, 'EnvironmentClusterArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]{12}:cluster/[A-Za-z0-9_-]+',
    });
    const subnetIds = new CfnParameter(this, 'EnvironmentSubnetIds', {
      type: 'List<AWS::EC2::Subnet::Id>',
    });
    const cloudFrontPrefixListId = new CfnParameter(this, 'CloudFrontOriginPrefixListId', {
      type: 'String',
      default: '',
      allowedPattern: '(|pl-[0-9a-f]+)',
      description: 'AWS-managed com.amazonaws.global.cloudfront.origin-facing prefix list in the workload Region.',
    });
    const securityGroupIds = new CfnParameter(this, 'EnvironmentSecurityGroupIds', {
      type: 'List<AWS::EC2::SecurityGroup::Id>',
    });
    const vpcId = new CfnParameter(this, 'EnvironmentVpcId', {
      type: 'AWS::EC2::VPC::Id',
    });
    const environmentMonitorSecurityGroupId = new CfnParameter(this, 'EnvironmentMonitorSecurityGroupId', {
      type: 'AWS::EC2::SecurityGroup::Id',
    });
    const awsEndpointSecurityGroupId = new CfnParameter(this, 'AwsInterfaceEndpointSecurityGroupId', {
      type: 'AWS::EC2::SecurityGroup::Id',
    });
    const s3PrefixListId = new CfnParameter(this, 'S3GatewayEndpointPrefixListId', {
      type: 'String',
      allowedPattern: 'pl-[0-9a-f]+',
    });
    const dynamoDbPrefixListId = new CfnParameter(this, 'DynamoDbGatewayEndpointPrefixListId', {
      type: 'String',
      allowedPattern: 'pl-[0-9a-f]+',
    });
    const vpcDnsResolverIpv4 = new CfnParameter(this, 'VpcDnsResolverIpv4', {
      type: 'String',
      allowedPattern:
        '(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])',
    });
    const executionRoleArn = new CfnParameter(this, 'EnvironmentExecutionRoleArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+',
    });
    const sessionTableStreamArn = new CfnParameter(this, 'SessionTableStreamArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:[0-9]{12}:table/[A-Za-z0-9_.-]+/stream/[A-Za-z0-9:_.-]+',
      description: 'Existing durable session table stream ARN.',
    });
    const monitorSecretBucketArn = new CfnParameter(this, 'MonitorBootstrapBucketArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:s3:::[a-z0-9][a-z0-9.-]*[a-z0-9]',
      description: 'Existing durable Monitor bootstrap-file bucket ARN.',
    });
    const recordingBucketName = new CfnParameter(this, 'RecordingBucketName', {
      type: 'String',
      minLength: 3,
      maxLength: 63,
      allowedPattern: '[a-z0-9][a-z0-9.-]*[a-z0-9]',
      description: 'Existing durable recording bucket name.',
    });
    const gatewayImageDigest = new CfnParameter(this, 'GatewayImageDigest', {
      type: 'String',
      default: '',
      allowedPattern: '(|sha256:[a-f0-9]{64})',
    });
    const gatewayDesiredCount = new CfnParameter(this, 'GatewayDesiredCount', {
      type: 'Number',
      default: 1,
      minValue: 1,
      maxValue: 4,
    });
    const gatewayRecordingCapacity = new CfnParameter(this, 'GatewayMaximumConcurrentRecordings', {
      type: 'Number',
      default: 16,
      minValue: 1,
      maxValue: 64,
    });
    const terminalEdgeWebAclArn = new CfnParameter(this, 'TerminalEdgeWebAclArn', {
      type: 'String',
      default: '',
      allowedPattern: '(|arn:aws:wafv2:us-east-1:[0-9]{12}:global/webacl/[A-Za-z0-9_-]+/[a-f0-9-]+)',
      description: 'CloudFront-scope Web ACL ARN from OpsReplayTerminalEdgeProtection in us-east-1.',
    });
    const bootstrapReadBurstLimit = new CfnParameter(this, 'BootstrapReadBurstLimit', {
      type: 'Number',
      default: 4,
      minValue: 1,
      maxValue: 64,
      description: 'Burst and per-action Lambda concurrency for each catalogue/account read route.',
    });
    const bootstrapReadRateLimit = new CfnParameter(this, 'BootstrapReadRateLimit', {
      type: 'Number',
      default: 2,
      minValue: 1,
      maxValue: 64,
      description: 'Sustained requests per second for each catalogue/account read route, shared by its callers.',
    });
    const terminalTicketBurstLimit = new CfnParameter(this, 'TerminalTicketBurstLimit', {
      type: 'Number',
      default: 16,
      minValue: 1,
      maxValue: maximumTerminalConnections,
      description: 'Shared terminal-ticket API burst and Lambda concurrency limit.',
    });
    const terminalTicketRateLimit = new CfnParameter(this, 'TerminalTicketRateLimit', {
      type: 'Number',
      default: 8,
      minValue: 1,
      maxValue: maximumTerminalConnections,
      description: 'Shared sustained terminal-ticket requests per second.',
    });
    const sessionStatusBurstLimit = new CfnParameter(this, 'SessionStatusBurstLimit', {
      type: 'Number',
      default: 16,
      minValue: 1,
      maxValue: 256,
      description: 'Session-status API burst and separate Lambda concurrency limit.',
    });
    const sessionStatusRateLimit = new CfnParameter(this, 'SessionStatusRateLimit', {
      type: 'Number',
      default: 8,
      minValue: 1,
      maxValue: 256,
      description: 'Sustained session-status requests per second.',
    });
    const startSessionBurstLimit = new CfnParameter(this, 'StartSessionBurstLimit', {
      type: 'Number',
      default: 8,
      minValue: 1,
      maxValue: 64,
      description: 'Session-start API burst limit. Lambda admission remains disabled until runtime activation.',
    });
    const startSessionRateLimit = new CfnParameter(this, 'StartSessionRateLimit', {
      type: 'Number',
      default: 4,
      minValue: 1,
      maxValue: 64,
      description: 'Sustained session-start requests per second.',
    });
    const terminalAllowedOrigins = new CfnParameter(this, 'TerminalAllowedOrigins', {
      type: 'String',
      default: '',
      maxLength: 4096,
      allowedPattern: terminalAllowedOriginsPattern,
      description: 'Comma-separated exact HTTP or HTTPS web origins accepted by the Gateway.',
    });
    const cognitoUserPoolArn = new CfnParameter(this, 'CognitoUserPoolArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:cognito-idp:[a-z0-9-]+:[0-9]{12}:userpool/[A-Za-z0-9_-]+',
      description: 'Existing durable learner user pool ARN.',
    });
    const cognitoIdentityMode = new CfnParameter(this, 'CognitoIdentityMode', {
      type: 'String',
      default: 'external',
      allowedValues: ['external', 'managed'],
      description: 'Use an existing client and login domain, or create disposable checkpoint-owned values.',
    });
    const cognitoUserPoolClientId = new CfnParameter(this, 'CognitoUserPoolClientId', {
      type: 'String',
      default: '',
      allowedPattern: '^(?:|[A-Za-z0-9]{1,128})$',
    });
    const cognitoLoginHostname = new CfnParameter(this, 'CognitoLoginHostname', {
      type: 'String',
      default: '',
      maxLength: 253,
      allowedPattern: `^(?:|${cognitoLoginHostnamePattern.slice(1, -1)})$`,
      description: 'Existing AWS-managed Cognito login hostname, without scheme or path.',
    });
    const cognitoDomainPrefix = new CfnParameter(this, 'CognitoDomainPrefix', {
      type: 'String',
      default: '',
      minLength: 0,
      maxLength: 63,
      allowedPattern: '^(?:|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$',
      description: 'Unique AWS-managed Cognito domain prefix when CognitoIdentityMode is managed.',
    });
    const publicApiAllowedOrigin = new CfnParameter(this, 'PublicApiAllowedOrigin', {
      type: 'String',
      default: '',
      maxLength: 300,
      allowedPattern: `^(?:|${publicApiOriginPattern.slice(1, -1)})$`,
      description: 'One exact browser origin allowed to read the public API.',
    });
    const browserCallbackUrl = new CfnParameter(this, 'BrowserCallbackUrl', {
      type: 'String',
      default: '',
      maxLength: 1024,
      allowedPattern: `^(?:|${browserRedirectPattern})$`,
      description: 'Exact authorization-code callback URL for the browser client.',
    });
    const browserLogoutUrl = new CfnParameter(this, 'BrowserLogoutUrl', {
      type: 'String',
      default: '',
      maxLength: 1024,
      allowedPattern: `^(?:|${browserRedirectPattern})$`,
      description: 'Exact post-logout URL for the browser client.',
    });
    const gatewayPathEnabled = new CfnParameter(this, 'EnableGatewayPath', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
      description: 'Enable the complete checkpoint runtime while keeping new-session admission separately gated.',
    });
    const sessionAdmissionEnabled = new CfnParameter(this, 'EnableSessionAdmission', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
      description: 'Permit new session starts only after the complete checkpoint runtime is enabled and verified.',
    });
    const gatewayEnabled = new CfnCondition(this, 'GatewayPathEnabled', {
      expression: Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
    });
    const admissionEnabled = new CfnCondition(this, 'SessionAdmissionEnabled', {
      expression: Fn.conditionAnd(
        Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
        Fn.conditionEquals(sessionAdmissionEnabled.valueAsString, 'true'),
      ),
    });
    const managedIdentity = new CfnCondition(this, 'ManagedCognitoIdentity', {
      expression: Fn.conditionEquals(cognitoIdentityMode.valueAsString, 'managed'),
    });
    const externalIdentityEnabled = new CfnCondition(this, 'ExternalCognitoIdentityEnabled', {
      expression: Fn.conditionAnd(
        Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
        Fn.conditionEquals(cognitoIdentityMode.valueAsString, 'external'),
      ),
    });
    new CloudFormationRule(this, 'EnvironmentSecurityGroupsIncludeMonitor', {
      assertions: [
        {
          assert: Fn.conditionContains(securityGroupIds.valueAsList, environmentMonitorSecurityGroupId.valueAsString),
          assertDescription: 'EnvironmentSecurityGroupIds must include EnvironmentMonitorSecurityGroupId.',
        },
      ],
    });
    new CloudFormationRule(this, 'GatewayPathConfigurationRequiredWhenEnabled', {
      ruleCondition: Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
      assertions: [
        {
          assert: Fn.conditionNot(Fn.conditionEquals(gatewayImageDigest.valueAsString, '')),
          assertDescription: 'GatewayImageDigest is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(cloudFrontPrefixListId.valueAsString, '')),
          assertDescription: 'CloudFrontOriginPrefixListId is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(terminalAllowedOrigins.valueAsString, '')),
          assertDescription: 'TerminalAllowedOrigins is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(terminalEdgeWebAclArn.valueAsString, '')),
          assertDescription: 'TerminalEdgeWebAclArn is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(publicApiAllowedOrigin.valueAsString, '')),
          assertDescription: 'PublicApiAllowedOrigin is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(browserCallbackUrl.valueAsString, '')),
          assertDescription: 'BrowserCallbackUrl is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(browserLogoutUrl.valueAsString, '')),
          assertDescription: 'BrowserLogoutUrl is required when EnableGatewayPath is true.',
        },
      ],
    });
    new CloudFormationRule(this, 'SessionAdmissionRequiresGatewayPath', {
      ruleCondition: Fn.conditionEquals(sessionAdmissionEnabled.valueAsString, 'true'),
      assertions: [
        {
          assert: Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
          assertDescription: 'EnableGatewayPath must be true before EnableSessionAdmission can be true.',
        },
      ],
    });
    new CloudFormationRule(this, 'ExternalCognitoConfigurationRequired', {
      ruleCondition: Fn.conditionAnd(
        Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
        Fn.conditionEquals(cognitoIdentityMode.valueAsString, 'external'),
      ),
      assertions: [
        {
          assert: Fn.conditionNot(Fn.conditionEquals(cognitoUserPoolClientId.valueAsString, '')),
          assertDescription: 'CognitoUserPoolClientId is required for external Cognito identity.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(cognitoLoginHostname.valueAsString, '')),
          assertDescription: 'CognitoLoginHostname is required for external Cognito identity.',
        },
        {
          assert: Fn.conditionEquals(cognitoDomainPrefix.valueAsString, ''),
          assertDescription: 'CognitoDomainPrefix is valid only for managed Cognito identity.',
        },
      ],
    });
    new CloudFormationRule(this, 'ManagedCognitoConfigurationRequired', {
      ruleCondition: Fn.conditionEquals(cognitoIdentityMode.valueAsString, 'managed'),
      assertions: [
        {
          assert: Fn.conditionNot(Fn.conditionEquals(cognitoDomainPrefix.valueAsString, '')),
          assertDescription: 'CognitoDomainPrefix is required for managed Cognito identity.',
        },
        {
          assert: Fn.conditionEquals(cognitoUserPoolClientId.valueAsString, ''),
          assertDescription: 'CognitoUserPoolClientId must be empty for managed Cognito identity.',
        },
        {
          assert: Fn.conditionEquals(cognitoLoginHostname.valueAsString, ''),
          assertDescription: 'CognitoLoginHostname must be empty for managed Cognito identity.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(browserCallbackUrl.valueAsString, '')),
          assertDescription: 'BrowserCallbackUrl is required for managed Cognito identity.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(browserLogoutUrl.valueAsString, '')),
          assertDescription: 'BrowserLogoutUrl is required for managed Cognito identity.',
        },
      ],
    });
    const userPoolId = Fn.select(1, Fn.split('/', cognitoUserPoolArn.valueAsString));
    const managedUserPoolClient = new CfnUserPoolClient(this, 'CheckpointUserPoolClient', {
      userPoolId,
      clientName: 'opsreplay-browser',
      generateSecret: false,
      allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthFlows: ['code'],
      explicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      allowedOAuthScopes: ['openid', 'email', 'profile'],
      callbackUrLs: [browserCallbackUrl.valueAsString],
      logoutUrLs: [browserLogoutUrl.valueAsString],
      supportedIdentityProviders: ['COGNITO'],
      enableTokenRevocation: true,
      preventUserExistenceErrors: 'ENABLED',
    });
    managedUserPoolClient.cfnOptions.condition = managedIdentity;
    const managedUserPoolDomain = new CfnUserPoolDomain(this, 'CheckpointUserPoolDomain', {
      domain: cognitoDomainPrefix.valueAsString,
      userPoolId,
    });
    managedUserPoolDomain.cfnOptions.condition = managedIdentity;
    const effectiveUserPoolClientId = Fn.conditionIf(
      managedIdentity.logicalId,
      managedUserPoolClient.ref,
      cognitoUserPoolClientId.valueAsString,
    ).toString();
    const publicApiEnvironment = {
      PUBLIC_API_ALLOWED_ORIGIN: publicApiAllowedOrigin.valueAsString,
      COGNITO_USER_POOL_CLIENT_ID: effectiveUserPoolClientId,
    };
    const sessionTableArn = Fn.select(0, Fn.split('/stream/', sessionTableStreamArn.valueAsString));
    const table = Table.fromTableAttributes(this, 'Sessions', {
      tableArn: sessionTableArn,
      tableStreamArn: sessionTableStreamArn.valueAsString,
      globalIndexes: [unfinishedWorkIndex.name],
    });
    const secretFiles = Bucket.fromBucketArn(this, 'MonitorSecretFiles', monitorSecretBucketArn.valueAsString);
    const recordings = Bucket.fromBucketName(this, 'Recordings', recordingBucketName.valueAsString);

    const gatewaySecurityGroup = new CfnSecurityGroup(this, 'GatewaySecurityGroup', {
      groupDescription: 'Private OpsReplay Gateway tasks.',
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [
        {
          ipProtocol: 'tcp',
          fromPort: 9443,
          toPort: 9443,
          destinationSecurityGroupId: environmentMonitorSecurityGroupId.valueAsString,
          description: 'Authenticated monitor control',
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
          fromPort: 443,
          toPort: 443,
          destinationPrefixListId: dynamoDbPrefixListId.valueAsString,
          description: 'DynamoDB gateway endpoint',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          destinationSecurityGroupId: awsEndpointSecurityGroupId.valueAsString,
          description: 'ECR and CloudWatch Logs interface endpoints',
        },
        {
          ipProtocol: 'tcp',
          fromPort: 53,
          toPort: 53,
          cidrIp: Fn.join('', [vpcDnsResolverIpv4.valueAsString, '/32']),
          description: 'VPC DNS resolver',
        },
        {
          ipProtocol: 'udp',
          fromPort: 53,
          toPort: 53,
          cidrIp: Fn.join('', [vpcDnsResolverIpv4.valueAsString, '/32']),
          description: 'VPC DNS resolver',
        },
      ],
    });
    const loadBalancerSecurityGroup = new CfnSecurityGroup(this, 'TerminalLoadBalancerSecurityGroup', {
      groupDescription: 'Private CloudFront origin for the OpsReplay terminal Gateway.',
      vpcId: vpcId.valueAsString,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 80,
          toPort: 80,
          sourcePrefixListId: cloudFrontPrefixListId.valueAsString,
          description: 'CloudFront VPC origin HTTP and WebSocket traffic',
        },
      ],
      securityGroupEgress: [
        {
          ipProtocol: 'tcp',
          fromPort: gatewayPort,
          toPort: gatewayPort,
          destinationSecurityGroupId: gatewaySecurityGroup.attrGroupId,
          description: 'Terminal Gateway targets',
        },
      ],
    });
    loadBalancerSecurityGroup.cfnOptions.condition = gatewayEnabled;
    const gatewayListenerIngress = new CfnSecurityGroupIngress(this, 'GatewayListenerIngress', {
      groupId: gatewaySecurityGroup.attrGroupId,
      sourceSecurityGroupId: loadBalancerSecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: gatewayPort,
      toPort: gatewayPort,
      description: 'Terminal load balancer health and WebSocket traffic',
    });
    gatewayListenerIngress.cfnOptions.condition = gatewayEnabled;
    const gatewayTerminalEgress = new CfnSecurityGroupEgress(this, 'GatewayTerminalEgress', {
      groupId: gatewaySecurityGroup.attrGroupId,
      destinationSecurityGroupId: environmentMonitorSecurityGroupId.valueAsString,
      ipProtocol: 'tcp',
      fromPort: terminalPort,
      toPort: terminalPort,
      description: 'Private Challenge terminal server',
    });
    gatewayTerminalEgress.cfnOptions.condition = gatewayEnabled;
    const terminalIngress = new CfnSecurityGroupIngress(this, 'TerminalIngress', {
      groupId: environmentMonitorSecurityGroupId.valueAsString,
      sourceSecurityGroupId: gatewaySecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: terminalPort,
      toPort: terminalPort,
      description: 'Gateway to private Challenge terminal server',
    });
    terminalIngress.cfnOptions.condition = gatewayEnabled;
    const monitorIngress = new CfnSecurityGroupIngress(this, 'MonitorIngress', {
      groupId: environmentMonitorSecurityGroupId.valueAsString,
      sourceSecurityGroupId: gatewaySecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 9443,
      toPort: 9443,
      description: 'Gateway to monitor control',
    });
    const awsEndpointIngress = new CfnSecurityGroupIngress(this, 'AwsEndpointIngress', {
      groupId: awsEndpointSecurityGroupId.valueAsString,
      sourceSecurityGroupId: gatewaySecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
      description: 'Gateway to private AWS interface endpoints',
    });
    const logs = new LogGroup(this, 'StartLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const expiryLogs = new LogGroup(this, 'ExpiryLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const expiryRole = new Role(this, 'ExpiryRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    expiryLogs.grantWrite(expiryRole);
    expiryRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*', 'USER#*'] } },
      }),
    );
    const taskArn = Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task',
      resourceName: '*',
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    expiryRole.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        resources: [taskArn],
        conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
      }),
    );
    // ECS ListTasks has no resource-level ARN. The cluster condition keeps the scan bounded.
    expiryRole.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:ListTasks'],
        resources: ['*'],
        conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
      }),
    );
    const expiry = new Function(this, 'ExpireProvisioning', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/expire-provisioning/', import.meta.url))),
      role: expiryRole,
      logGroup: expiryLogs,
      environment: { SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(20),
      reservedConcurrentExecutions: 0,
    });
    const scheduleGroup = new CfnScheduleGroup(this, 'SessionSchedules');
    scheduleGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
    expiry.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.minutes(15) });
    new Alarm(this, 'ExpiryEventDropped', {
      metric: expiry.metric('AsyncEventsDropped', { statistic: 'Sum', period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription:
        'Provisioning cleanup was dropped. Inspect expiry logs and retry cleanup for the affected session.',
    });
    new Alarm(this, 'ScheduleDeliveryDropped', {
      metric: new Metric({
        namespace: 'AWS/Scheduler',
        metricName: 'InvocationDroppedCount',
        dimensionsMap: { ScheduleGroup: scheduleGroup.ref },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A session cleanup callback could not be delivered. Inspect the session schedule group.',
    });
    const schedulerRole = new Role(this, 'SchedulerTargetRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
    expiry.grantInvoke(schedulerRole);

    const role = new Role(this, 'StartRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    logs.grantWrite(role);
    role.addToPolicy(
      new PolicyStatement({
        actions: ['s3:GetObjectTagging', 's3:PutObject', 's3:PutObjectTagging'],
        resources: [secretFiles.arnForObjects('sessions/*')],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
        resources: [table.tableArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'SESSION#*'] } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*', 'USER#*'] } },
      }),
    );
    const scheduleArn = Stack.of(this).formatArn({
      service: 'scheduler',
      resource: 'schedule',
      resourceName: Fn.join('/', [scheduleGroup.ref, 'session-*']),
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const lifecycleSchedulerRole = new Role(this, 'LifecycleSchedulerTargetRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
    const lifecycleRoles: Role[] = [];
    const lifecycleFunction = (id: string, bundle: string, timeout: number, concurrency: number) => {
      const functionLogs = new LogGroup(this, `${id}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const functionRole = new Role(this, `${id}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
      functionLogs.grantWrite(functionRole);
      functionRole.addToPolicy(
        new PolicyStatement({
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:ConditionCheckItem',
          ],
          resources: [table.tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*', 'USER#*'] } },
        }),
      );
      functionRole.addToPolicy(
        new PolicyStatement({
          actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
          resources: [taskArn],
          conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
        }),
      );
      functionRole.addToPolicy(
        new PolicyStatement({
          actions: ['ecs:ListTasks'],
          resources: ['*'],
          conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
        }),
      );
      functionRole.addToPolicy(
        new PolicyStatement({
          actions: [
            'scheduler:GetSchedule',
            'scheduler:CreateSchedule',
            'scheduler:UpdateSchedule',
            'scheduler:DeleteSchedule',
          ],
          resources: [scheduleArn],
        }),
      );
      functionRole.addToPolicy(
        new PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [lifecycleSchedulerRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
        }),
      );
      lifecycleRoles.push(functionRole);
      return new Function(this, id, {
        runtime: Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: Code.fromAsset(fileURLToPath(new URL(`../dist/${bundle}/`, import.meta.url))),
        role: functionRole,
        logGroup: functionLogs,
        environment: {
          SESSION_TABLE_NAME: table.tableName,
          SCHEDULER_GROUP_NAME: scheduleGroup.ref,
          SCHEDULER_TARGET_ROLE_ARN: lifecycleSchedulerRole.roleArn,
          AWS_PARTITION: Aws.PARTITION,
          AWS_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        // Sweep can finalise five bounded evidence sets concurrently.
        memorySize: id === 'SweepSessions' ? 1024 : 512,
        timeout: Duration.seconds(timeout),
        reservedConcurrentExecutions: Fn.conditionIf(gatewayEnabled.logicalId, concurrency, 0) as unknown as number,
      });
    };
    const reconcileSession = lifecycleFunction(
      'ReconcileSession',
      'reconcile-session',
      30,
      reconcileSessionConcurrency,
    );
    const sweepSessions = lifecycleFunction('SweepSessions', 'sweep-sessions', 60, sweepSessionsConcurrency);
    for (const action of [reconcileSession, sweepSessions]) {
      action.addEnvironment('RECORDING_BUCKET_NAME', recordings.bucketName);
      action.addToRolePolicy(
        new PolicyStatement({
          actions: ['dynamodb:Query'],
          resources: [table.tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
        }),
      );
      action.addToRolePolicy(
        new PolicyStatement({
          actions: ['dynamodb:GetItem'],
          resources: [table.tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONTENT#challenge#*'] } },
        }),
      );
      action.addToRolePolicy(
        new PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [
            recordings.arnForObjects('sessions/*/metrics/*/sealed/*'),
            recordings.arnForObjects('sessions/*/metrics/*/live/*'),
            recordings.arnForObjects('sessions/*/terminal/*/sealed/*'),
            recordings.arnForObjects('sessions/*/terminal/*/live/*'),
            recordings.arnForObjects('sessions/*/playback/*'),
          ],
        }),
      );
    }
    for (const action of [reconcileSession, sweepSessions]) {
      action.addToRolePolicy(
        new PolicyStatement({
          actions: ['s3:PutObject', 's3:PutObjectTagging'],
          resources: [recordings.arnForObjects('sessions/*/playback/*')],
          conditions: {
            StringEquals: {
              [`s3:RequestObjectTag/${recordingRetention.tagKey}`]: [
                recordingRetention.provisionalTagValue,
                recordingRetention.sealedTagValue,
              ],
            },
            'ForAllValues:StringEquals': { 's3:RequestObjectTagKeys': [recordingRetention.tagKey] },
          },
        }),
      );
      action.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.DENY,
          actions: ['s3:PutObjectTagging'],
          resources: [recordings.arnForObjects('sessions/*/playback/*')],
          conditions: { Null: { [`s3:ExistingObjectTag/${recordingRetention.tagKey}`]: 'false' } },
        }),
      );
    }
    sweepSessions.addEnvironment('SESSION_RECONCILE_FUNCTION_ARN', reconcileSession.functionArn);
    reconcileSession.grantInvoke(lifecycleSchedulerRole);
    reconcileSession.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.minutes(15) });
    sweepSessions.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: Duration.minutes(2) });
    const sweepRole = lifecycleRoles[1]!;
    sweepRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/${unfinishedWorkIndex.name}`],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['LIFECYCLE'] } },
      }),
    );
    sweepRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['LIFECYCLE_SWEEP'] } },
      }),
    );
    lifecycleRoles[0]!.addToPolicy(
      new PolicyStatement({
        actions: [
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
          'dynamodb:ListStreams',
        ],
        resources: [table.tableStreamArn!],
      }),
    );
    new CfnEventSourceMapping(this, 'LifecycleStream', {
      functionName: reconcileSession.functionArn,
      eventSourceArn: table.tableStreamArn!,
      startingPosition: 'LATEST',
      batchSize: 25,
      bisectBatchOnFunctionError: true,
      maximumRetryAttempts: 3,
      maximumRecordAgeInSeconds: 3600,
      enabled: Fn.conditionIf(gatewayEnabled.logicalId, true, false) as unknown as boolean,
      filterCriteria: {
        filters: [
          {
            pattern: JSON.stringify({
              eventName: ['INSERT', 'MODIFY'],
              dynamodb: { Keys: { SK: { S: [{ prefix: lifecycleHintPrefix }] } } },
            }),
          },
        ],
      },
    });
    const lifecycleSweepRule = new Rule(this, 'LifecycleSweep', {
      schedule: Schedule.rate(Duration.minutes(1)),
      enabled: false,
    });
    const lifecycleSweepCfnRule = lifecycleSweepRule.node.defaultChild as CfnRule;
    lifecycleSweepCfnRule.state = Fn.conditionIf(gatewayEnabled.logicalId, 'ENABLED', 'DISABLED') as unknown as string;
    lifecycleSweepRule.addTarget(
      new LambdaFunction(sweepSessions, { retryAttempts: 0, maxEventAge: Duration.minutes(2) }),
    );
    const lifecycleStoppedRule = new Rule(this, 'LifecycleTaskStopped', {
      enabled: false,
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: { clusterArn: [clusterArn.valueAsString], lastStatus: ['STOPPED'] },
      },
    });
    const lifecycleStoppedCfnRule = lifecycleStoppedRule.node.defaultChild as CfnRule;
    lifecycleStoppedCfnRule.state = Fn.conditionIf(
      gatewayEnabled.logicalId,
      'ENABLED',
      'DISABLED',
    ) as unknown as string;
    lifecycleStoppedRule.addTarget(
      new LambdaFunction(reconcileSession, { retryAttempts: 2, maxEventAge: Duration.hours(1) }),
    );
    for (const fn of [reconcileSession, sweepSessions])
      new Alarm(this, `${fn.node.id}Errors`, {
        metric: fn.metricErrors({ statistic: 'Sum', period: Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
        alarmDescription:
          'Inspect lifecycle failure logs and retry the affected session. The active lock remains held.',
      });

    role.addToPolicy(
      new PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:GetSchedule'],
        resources: [scheduleArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [lifecycleSchedulerRole.roleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );
    const taskDefinitionArn = Stack.of(this).formatArn({
      service: 'ecs',
      resource: 'task-definition',
      resourceName: 'opsreplay-*',
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [taskDefinitionArn],
        conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:TagResource'],
        resources: [taskArn],
        conditions: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['ecs:StopTask'],
        resources: [taskArn],
        conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [executionRoleArn.valueAsString],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );
    for (const lifecycleRole of lifecycleRoles) {
      lifecycleRole.addToPolicy(
        new PolicyStatement({
          actions: ['ecs:RunTask'],
          resources: [taskDefinitionArn],
          conditions: { ArnEquals: { 'ecs:cluster': clusterArn.valueAsString } },
        }),
      );
      lifecycleRole.addToPolicy(
        new PolicyStatement({
          actions: ['ecs:TagResource'],
          resources: [taskArn],
          conditions: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
        }),
      );
      lifecycleRole.addToPolicy(
        new PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [executionRoleArn.valueAsString],
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      );
      lifecycleRole.addToPolicy(
        new PolicyStatement({
          actions: ['s3:GetObjectTagging', 's3:PutObject', 's3:PutObjectTagging'],
          resources: [secretFiles.arnForObjects('sessions/*')],
        }),
      );
    }
    const startSession = new Function(this, 'StartSession', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/start-session/', import.meta.url))),
      role,
      logGroup: logs,
      environment: {
        ...publicApiEnvironment,
        SESSION_TABLE_NAME: table.tableName,
        ECS_CLUSTER_ARN: clusterArn.valueAsString,
        ECS_SUBNET_IDS: Fn.join(',', subnetIds.valueAsList),
        ECS_SECURITY_GROUP_IDS: Fn.join(',', securityGroupIds.valueAsList),
        ECS_PLATFORM_VERSION: '1.4.0',
        MONITOR_CONTAINER_NAME: 'monitor',
        MONITOR_SECRET_BUCKET_ARN: secretFiles.bucketArn,
        SCHEDULER_GROUP_NAME: scheduleGroup.ref,
        PROVISIONING_EXPIRY_FUNCTION_ARN: reconcileSession.functionArn,
        SCHEDULER_TARGET_ROLE_ARN: lifecycleSchedulerRole.roleArn,
      },
      memorySize: 256,
      timeout: Duration.seconds(20),
      reservedConcurrentExecutions: Fn.conditionIf(
        admissionEnabled.logicalId,
        startSessionBurstLimit.valueAsNumber,
        0,
      ) as unknown as number,
    });

    const terminalTicketLogs = new LogGroup(this, 'TerminalTicketLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const terminalTicketRole = new Role(this, 'TerminalTicketRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    terminalTicketLogs.grantWrite(terminalTicketRole);
    terminalTicketRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem', 'dynamodb:PutItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      }),
    );
    const terminalTicket = new Function(this, 'CreateTerminalTicket', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/create-terminal-ticket/', import.meta.url))),
      role: terminalTicketRole,
      logGroup: terminalTicketLogs,
      environment: {
        ...publicApiEnvironment,
        SESSION_TABLE_NAME: table.tableName,
      },
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: Fn.conditionIf(
        gatewayEnabled.logicalId,
        terminalTicketBurstLimit.valueAsNumber,
        0,
      ) as unknown as number,
    });

    const sessionStatusLogs = new LogGroup(this, 'SessionStatusLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const sessionStatusRole = new Role(this, 'SessionStatusRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    sessionStatusLogs.grantWrite(sessionStatusRole);
    sessionStatusRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      }),
    );
    const getSession = new Function(this, 'GetSession', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/get-session/', import.meta.url))),
      role: sessionStatusRole,
      logGroup: sessionStatusLogs,
      environment: { ...publicApiEnvironment, SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: Fn.conditionIf(
        gatewayEnabled.logicalId,
        sessionStatusBurstLimit.valueAsNumber,
        0,
      ) as unknown as number,
    });

    const endLogs = new LogGroup(this, 'EndSessionLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const endRole = new Role(this, 'EndSessionRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    endLogs.grantWrite(endRole);
    endRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      }),
    );
    const endSession = new Function(this, 'EndSession', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/end-session/', import.meta.url))),
      role: endRole,
      logGroup: endLogs,
      environment: { ...publicApiEnvironment, SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: Fn.conditionIf(
        gatewayEnabled.logicalId,
        ownerEndConcurrency,
        0,
      ) as unknown as number,
    });

    const hintLogs = new LogGroup(this, 'ReleaseHintLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const hintRole = new Role(this, 'ReleaseHintRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    hintLogs.grantWrite(hintRole);
    hintRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      }),
    );
    hintRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONTENT#challenge#*'] } },
      }),
    );
    const releaseHint = new Function(this, 'ReleaseHint', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/release-hint/', import.meta.url))),
      role: hintRole,
      logGroup: hintLogs,
      environment: { ...publicApiEnvironment, SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: Fn.conditionIf(
        gatewayEnabled.logicalId,
        hintReleaseConcurrency,
        0,
      ) as unknown as number,
    });

    const bootstrapFunctions = [
      ['ListCatalog', 'list-catalog', false],
      ['GetAccount', 'get-account', true],
    ] as const;
    const bootstrapActions = bootstrapFunctions.map(([id, bundle, authenticated]) => {
      const actionLogs = new LogGroup(this, `${id}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const actionRole = new Role(this, `${id}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
      actionLogs.grantWrite(actionRole);
      actionRole.addToPolicy(
        new PolicyStatement({
          actions: authenticated ? ['dynamodb:TransactGetItems', 'dynamodb:GetItem'] : ['dynamodb:Query'],
          resources: [table.tableArn],
          conditions: {
            'ForAllValues:StringLike': {
              'dynamodb:LeadingKeys': authenticated ? ['USER#*', 'SESSION#*'] : ['CATALOG#PUBLIC'],
            },
          },
        }),
      );
      const action = new Function(this, id, {
        runtime: Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: Code.fromAsset(fileURLToPath(new URL(`../dist/${bundle}/`, import.meta.url))),
        role: actionRole,
        logGroup: actionLogs,
        environment: { ...publicApiEnvironment, SESSION_TABLE_NAME: table.tableName },
        memorySize: 256,
        timeout: Duration.seconds(10),
        reservedConcurrentExecutions: Fn.conditionIf(
          gatewayEnabled.logicalId,
          bootstrapReadBurstLimit.valueAsNumber,
          0,
        ) as unknown as number,
      });
      return { id, action, authenticated, path: authenticated ? 'me' : 'catalog' };
    });

    const terminalApi = new CfnRestApi(this, 'TerminalTicketApi', {
      name: 'opsreplay-terminal-ticket',
      description: 'Authenticated session actions for the bounded checkpoint path.',
      endpointConfiguration: { types: ['REGIONAL'] },
    });
    terminalApi.cfnOptions.condition = gatewayEnabled;
    const terminalAuthorizer = new CfnAuthorizer(this, 'TerminalTicketAuthorizer', {
      name: 'opsreplay-terminal-ticket-cognito',
      restApiId: terminalApi.ref,
      type: 'COGNITO_USER_POOLS',
      identitySource: 'method.request.header.Authorization',
      providerArns: [cognitoUserPoolArn.valueAsString],
      authorizerResultTtlInSeconds: 300,
    });
    terminalAuthorizer.cfnOptions.condition = gatewayEnabled;
    const terminalApiV1 = new ApiGatewayResource(this, 'TerminalTicketApiV1', {
      restApiId: terminalApi.ref,
      parentId: terminalApi.attrRootResourceId,
      pathPart: 'v1',
    });
    terminalApiV1.cfnOptions.condition = gatewayEnabled;
    const bootstrapRoutes = bootstrapActions.map(({ id, action, authenticated, path }) => {
      const resource = new ApiGatewayResource(this, `${id}Resource`, {
        restApiId: terminalApi.ref,
        parentId: terminalApiV1.ref,
        pathPart: path,
      });
      resource.cfnOptions.condition = gatewayEnabled;
      const method = new CfnMethod(this, `${id}Method`, {
        restApiId: terminalApi.ref,
        resourceId: resource.ref,
        httpMethod: 'GET',
        authorizationType: authenticated ? 'COGNITO_USER_POOLS' : 'NONE',
        ...(authenticated ? { authorizerId: terminalAuthorizer.ref } : {}),
        apiKeyRequired: false,
        operationName: authenticated ? 'getAccount' : 'listCatalog',
        integration: {
          type: 'AWS_PROXY',
          integrationHttpMethod: 'POST',
          timeoutInMillis: 8000,
          uri: Fn.join('', [
            'arn:',
            Aws.PARTITION,
            ':apigateway:',
            Aws.REGION,
            ':lambda:path/2015-03-31/functions/',
            action.functionArn,
            '/invocations',
          ]),
        },
      });
      method.cfnOptions.condition = gatewayEnabled;
      const permission = new CfnPermission(this, `${id}ApiPermission`, {
        action: 'lambda:InvokeFunction',
        functionName: action.functionArn,
        principal: 'apigateway.amazonaws.com',
        sourceArn: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':execute-api:',
          Aws.REGION,
          ':',
          Aws.ACCOUNT_ID,
          ':',
          terminalApi.ref,
          `/*/GET/v1/${path}`,
        ]),
      });
      permission.cfnOptions.condition = gatewayEnabled;
      return { id, resource, method, path };
    });
    const terminalApiSessions = new ApiGatewayResource(this, 'TerminalTicketApiSessions', {
      restApiId: terminalApi.ref,
      parentId: terminalApiV1.ref,
      pathPart: 'sessions',
    });
    terminalApiSessions.cfnOptions.condition = gatewayEnabled;
    const startSessionMethod = new CfnMethod(this, 'StartSessionMethod', {
      restApiId: terminalApi.ref,
      resourceId: terminalApiSessions.ref,
      httpMethod: 'POST',
      authorizationType: 'COGNITO_USER_POOLS',
      authorizerId: terminalAuthorizer.ref,
      apiKeyRequired: false,
      operationName: 'startSession',
      integration: {
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        timeoutInMillis: 21_000,
        uri: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':apigateway:',
          Aws.REGION,
          ':lambda:path/2015-03-31/functions/',
          startSession.functionArn,
          '/invocations',
        ]),
      },
    });
    startSessionMethod.cfnOptions.condition = gatewayEnabled;
    const startSessionPermission = new CfnPermission(this, 'StartSessionApiPermission', {
      action: 'lambda:InvokeFunction',
      functionName: startSession.functionArn,
      principal: 'apigateway.amazonaws.com',
      sourceArn: Fn.join('', [
        'arn:',
        Aws.PARTITION,
        ':execute-api:',
        Aws.REGION,
        ':',
        Aws.ACCOUNT_ID,
        ':',
        terminalApi.ref,
        '/*/POST/v1/sessions',
      ]),
    });
    startSessionPermission.cfnOptions.condition = gatewayEnabled;
    const terminalApiSession = new ApiGatewayResource(this, 'TerminalTicketApiSession', {
      restApiId: terminalApi.ref,
      parentId: terminalApiSessions.ref,
      pathPart: '{id}',
    });
    terminalApiSession.cfnOptions.condition = gatewayEnabled;
    const getSessionMethod = new CfnMethod(this, 'GetSessionMethod', {
      restApiId: terminalApi.ref,
      resourceId: terminalApiSession.ref,
      httpMethod: 'GET',
      authorizationType: 'COGNITO_USER_POOLS',
      authorizerId: terminalAuthorizer.ref,
      apiKeyRequired: false,
      operationName: 'getSession',
      integration: {
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        timeoutInMillis: 8_000,
        uri: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':apigateway:',
          Aws.REGION,
          ':lambda:path/2015-03-31/functions/',
          getSession.functionArn,
          '/invocations',
        ]),
      },
    });
    getSessionMethod.cfnOptions.condition = gatewayEnabled;
    const getSessionPermission = new CfnPermission(this, 'SessionStatusApiPermission', {
      action: 'lambda:InvokeFunction',
      functionName: getSession.functionArn,
      principal: 'apigateway.amazonaws.com',
      sourceArn: Fn.join('', [
        'arn:',
        Aws.PARTITION,
        ':execute-api:',
        Aws.REGION,
        ':',
        Aws.ACCOUNT_ID,
        ':',
        terminalApi.ref,
        '/*/GET/v1/sessions/*',
      ]),
    });
    getSessionPermission.cfnOptions.condition = gatewayEnabled;
    const resultMethods: CfnMethod[] = [];
    const resultCorsResources: { id: string; resource: ApiGatewayResource }[] = [];
    for (const [id, action, path, memory] of [
      ['GetDebrief', 'get-debrief', 'debrief', 256],
      ['ListTimeline', 'list-timeline', 'timeline', 512],
      ['GetPlayback', 'get-playback', 'playback', 512],
    ] as const) {
      const logs = new LogGroup(this, `${id}Logs`, {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const role = new Role(this, `${id}Role`, { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
      logs.grantWrite(role);
      role.addToPolicy(
        new PolicyStatement({
          actions: path === 'debrief' ? ['dynamodb:GetItem'] : ['dynamodb:GetItem', 'dynamodb:Query'],
          resources: [table.tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
        }),
      );
      if (path !== 'debrief')
        role.addToPolicy(
          new PolicyStatement({
            actions: ['s3:GetObject'],
            resources:
              path === 'timeline'
                ? [recordings.arnForObjects('sessions/*/metrics/*/sealed/*')]
                : [
                    recordings.arnForObjects('sessions/*/playback/*'),
                    recordings.arnForObjects('sessions/*/captures/*'),
                  ],
          }),
        );
      const fn = new Function(this, id, {
        runtime: Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: Code.fromAsset(fileURLToPath(new URL(`../dist/${action}/`, import.meta.url))),
        role,
        logGroup: logs,
        environment: {
          ...publicApiEnvironment,
          SESSION_TABLE_NAME: table.tableName,
          ...(path === 'debrief' ? {} : { RECORDING_BUCKET_NAME: recordings.bucketName }),
        },
        memorySize: memory,
        timeout: Duration.seconds(path === 'debrief' ? 10 : 25),
        reservedConcurrentExecutions: Fn.conditionIf(
          gatewayEnabled.logicalId,
          resultReadConcurrency,
          0,
        ) as unknown as number,
      });
      const resource = new ApiGatewayResource(this, `${id}Resource`, {
        restApiId: terminalApi.ref,
        parentId: terminalApiSession.ref,
        pathPart: path,
      });
      resource.cfnOptions.condition = gatewayEnabled;
      resultCorsResources.push({ id, resource });
      const method = new CfnMethod(this, `${id}Method`, {
        restApiId: terminalApi.ref,
        resourceId: resource.ref,
        httpMethod: 'GET',
        authorizationType: 'COGNITO_USER_POOLS',
        authorizerId: terminalAuthorizer.ref,
        apiKeyRequired: false,
        operationName: action,
        integration: {
          type: 'AWS_PROXY',
          integrationHttpMethod: 'POST',
          timeoutInMillis: path === 'debrief' ? 8000 : 23000,
          uri: Fn.join('', [
            'arn:',
            Aws.PARTITION,
            ':apigateway:',
            Aws.REGION,
            ':lambda:path/2015-03-31/functions/',
            fn.functionArn,
            '/invocations',
          ]),
        },
      });
      method.cfnOptions.condition = gatewayEnabled;
      const permission = new CfnPermission(this, `${id}ApiPermission`, {
        action: 'lambda:InvokeFunction',
        functionName: fn.functionArn,
        principal: 'apigateway.amazonaws.com',
        sourceArn: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':execute-api:',
          Aws.REGION,
          ':',
          Aws.ACCOUNT_ID,
          ':',
          terminalApi.ref,
          `/*/GET/v1/sessions/*/${path}`,
        ]),
      });
      permission.cfnOptions.condition = gatewayEnabled;
      resultMethods.push(method);
    }
    const endResource = new ApiGatewayResource(this, 'SessionEndResource', {
      restApiId: terminalApi.ref,
      parentId: terminalApiSession.ref,
      pathPart: 'end',
    });
    endResource.cfnOptions.condition = gatewayEnabled;
    const endMethod = new CfnMethod(this, 'EndSessionMethod', {
      restApiId: terminalApi.ref,
      resourceId: endResource.ref,
      httpMethod: 'POST',
      authorizationType: 'COGNITO_USER_POOLS',
      authorizerId: terminalAuthorizer.ref,
      apiKeyRequired: false,
      operationName: 'endSession',
      integration: {
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        timeoutInMillis: 8000,
        uri: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':apigateway:',
          Aws.REGION,
          ':lambda:path/2015-03-31/functions/',
          endSession.functionArn,
          '/invocations',
        ]),
      },
    });
    endMethod.cfnOptions.condition = gatewayEnabled;
    const endPermission = new CfnPermission(this, 'EndSessionApiPermission', {
      action: 'lambda:InvokeFunction',
      functionName: endSession.functionArn,
      principal: 'apigateway.amazonaws.com',
      sourceArn: Fn.join('', [
        'arn:',
        Aws.PARTITION,
        ':execute-api:',
        Aws.REGION,
        ':',
        Aws.ACCOUNT_ID,
        ':',
        terminalApi.ref,
        '/*/POST/v1/sessions/*/end',
      ]),
    });
    endPermission.cfnOptions.condition = gatewayEnabled;
    const hintResource = new ApiGatewayResource(this, 'SessionHintResource', {
      restApiId: terminalApi.ref,
      parentId: terminalApiSession.ref,
      pathPart: 'hints',
    });
    hintResource.cfnOptions.condition = gatewayEnabled;
    const hintMethod = new CfnMethod(this, 'ReleaseHintMethod', {
      restApiId: terminalApi.ref,
      resourceId: hintResource.ref,
      httpMethod: 'POST',
      authorizationType: 'COGNITO_USER_POOLS',
      authorizerId: terminalAuthorizer.ref,
      apiKeyRequired: false,
      operationName: 'releaseHint',
      integration: {
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        timeoutInMillis: 8_000,
        uri: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':apigateway:',
          Aws.REGION,
          ':lambda:path/2015-03-31/functions/',
          releaseHint.functionArn,
          '/invocations',
        ]),
      },
    });
    hintMethod.cfnOptions.condition = gatewayEnabled;
    const hintPermission = new CfnPermission(this, 'ReleaseHintApiPermission', {
      action: 'lambda:InvokeFunction',
      functionName: releaseHint.functionArn,
      principal: 'apigateway.amazonaws.com',
      sourceArn: Fn.join('', [
        'arn:',
        Aws.PARTITION,
        ':execute-api:',
        Aws.REGION,
        ':',
        Aws.ACCOUNT_ID,
        ':',
        terminalApi.ref,
        '/*/POST/v1/sessions/*/hints',
      ]),
    });
    hintPermission.cfnOptions.condition = gatewayEnabled;
    const terminalApiTickets = new ApiGatewayResource(this, 'TerminalTicketApiTickets', {
      restApiId: terminalApi.ref,
      parentId: terminalApiSession.ref,
      pathPart: 'terminal-tickets',
    });
    terminalApiTickets.cfnOptions.condition = gatewayEnabled;
    const terminalTicketMethod = new CfnMethod(this, 'CreateTerminalTicketMethod', {
      restApiId: terminalApi.ref,
      resourceId: terminalApiTickets.ref,
      httpMethod: 'POST',
      authorizationType: 'COGNITO_USER_POOLS',
      authorizerId: terminalAuthorizer.ref,
      apiKeyRequired: false,
      operationName: 'createTerminalTicket',
      integration: {
        type: 'AWS_PROXY',
        integrationHttpMethod: 'POST',
        timeoutInMillis: 8_000,
        uri: Fn.join('', [
          'arn:',
          Aws.PARTITION,
          ':apigateway:',
          Aws.REGION,
          ':lambda:path/2015-03-31/functions/',
          terminalTicket.functionArn,
          '/invocations',
        ]),
      },
    });
    terminalTicketMethod.cfnOptions.condition = gatewayEnabled;
    const terminalTicketPermission = new CfnPermission(this, 'TerminalTicketApiPermission', {
      action: 'lambda:InvokeFunction',
      functionName: terminalTicket.functionArn,
      principal: 'apigateway.amazonaws.com',
      sourceArn: Fn.join('', [
        'arn:',
        Aws.PARTITION,
        ':execute-api:',
        Aws.REGION,
        ':',
        Aws.ACCOUNT_ID,
        ':',
        terminalApi.ref,
        '/*/POST/v1/sessions/*/terminal-tickets',
      ]),
    });
    terminalTicketPermission.cfnOptions.condition = gatewayEnabled;
    const corsPreflight = (id: string, resource: ApiGatewayResource, methods: string[]) => {
      const responseParameters = {
        'method.response.header.Access-Control-Allow-Headers': "'Authorization,Content-Type'",
        'method.response.header.Access-Control-Allow-Methods': `'${methods.join(',')}'`,
        'method.response.header.Access-Control-Allow-Origin': Fn.join('', [
          "'",
          publicApiAllowedOrigin.valueAsString,
          "'",
        ]),
        'method.response.header.Cache-Control': "'no-store'",
        'method.response.header.Vary': "'Origin'",
      };
      const method = new CfnMethod(this, `${id}OptionsMethod`, {
        restApiId: terminalApi.ref,
        resourceId: resource.ref,
        httpMethod: 'OPTIONS',
        authorizationType: 'NONE',
        apiKeyRequired: false,
        integration: {
          type: 'MOCK',
          requestTemplates: { 'application/json': '{"statusCode":204}' },
          integrationResponses: [{ statusCode: '204', responseParameters }],
        },
        methodResponses: [
          {
            statusCode: '204',
            responseParameters: Object.fromEntries(Object.keys(responseParameters).map((key) => [key, true])),
          },
        ],
      });
      method.cfnOptions.condition = gatewayEnabled;
      return method;
    };
    const corsMethods = [
      ...bootstrapRoutes.map(({ id, resource }) => corsPreflight(`${id}Cors`, resource, ['GET', 'OPTIONS'])),
      corsPreflight('Sessions', terminalApiSessions, ['OPTIONS', 'POST']),
      corsPreflight('Session', terminalApiSession, ['GET', 'OPTIONS']),
      corsPreflight('SessionEnd', endResource, ['OPTIONS', 'POST']),
      corsPreflight('SessionHints', hintResource, ['OPTIONS', 'POST']),
      corsPreflight('TerminalTickets', terminalApiTickets, ['OPTIONS', 'POST']),
      ...resultCorsResources.map(({ id, resource }) => corsPreflight(`${id}Cors`, resource, ['GET', 'OPTIONS'])),
    ];
    const terminalTicketGatewayResponse = (
      id: string,
      responseType: string,
      statusCode: string,
      code: string,
      message: string,
    ) => {
      const response = new CfnGatewayResponse(this, id, {
        restApiId: terminalApi.ref,
        responseType,
        statusCode,
        responseParameters: {
          'gatewayresponse.header.Access-Control-Allow-Origin': Fn.join('', [
            "'",
            publicApiAllowedOrigin.valueAsString,
            "'",
          ]),
          'gatewayresponse.header.Cache-Control': "'no-store'",
          'gatewayresponse.header.Content-Type': "'application/json'",
          'gatewayresponse.header.Vary': "'Origin'",
        },
        responseTemplates: {
          'application/json': JSON.stringify({ code, message, requestId: '$context.requestId' }),
        },
      });
      response.cfnOptions.condition = gatewayEnabled;
      return response;
    };
    const terminalTicketGatewayResponses = [
      terminalTicketGatewayResponse(
        'TerminalTicketThrottled',
        'THROTTLED',
        '429',
        'LIMIT_EXCEEDED',
        'Too many session requests. Try again.',
      ),
      terminalTicketGatewayResponse(
        'TerminalTicketUnauthorized',
        'UNAUTHORIZED',
        '401',
        'UNAUTHENTICATED',
        'Sign in before accessing a session.',
      ),
      terminalTicketGatewayResponse(
        'TerminalTicketAccessDenied',
        'ACCESS_DENIED',
        '403',
        'ACCESS_DENIED',
        'Access to this session is denied.',
      ),
      terminalTicketGatewayResponse(
        'TerminalTicketDefault4xx',
        'DEFAULT_4XX',
        '400',
        'INVALID_REQUEST',
        'The session request was rejected.',
      ),
      terminalTicketGatewayResponse(
        'TerminalTicketDefault5xx',
        'DEFAULT_5XX',
        '500',
        'INTERNAL_ERROR',
        'The session request could not be completed. Try again.',
      ),
    ];
    // API Gateway deployments are immutable snapshots. Bump this version when the route model changes.
    const terminalTicketDeployment = new CfnDeployment(
      this,
      `TerminalTicketApiDeploymentV${terminalTicketApiDeploymentVersion}`,
      {
        restApiId: terminalApi.ref,
        description: `Authenticated session routes version ${terminalTicketApiDeploymentVersion}.`,
      },
    );
    terminalTicketDeployment.cfnOptions.condition = gatewayEnabled;
    for (const { method } of bootstrapRoutes) terminalTicketDeployment.addResourceDependency(method);
    terminalTicketDeployment.addResourceDependency(startSessionMethod);
    terminalTicketDeployment.addResourceDependency(terminalTicketMethod);
    terminalTicketDeployment.addResourceDependency(getSessionMethod);
    terminalTicketDeployment.addResourceDependency(endMethod);
    terminalTicketDeployment.addResourceDependency(hintMethod);
    for (const method of resultMethods) terminalTicketDeployment.addResourceDependency(method);
    for (const method of corsMethods) terminalTicketDeployment.addResourceDependency(method);
    for (const response of terminalTicketGatewayResponses) {
      terminalTicketDeployment.addResourceDependency(response);
    }
    const terminalTicketStage = new CfnStage(this, 'TerminalTicketApiStage', {
      restApiId: terminalApi.ref,
      deploymentId: terminalTicketDeployment.ref,
      stageName: 'checkpoint',
      methodSettings: [
        ...bootstrapRoutes.map(({ path }) => ({
          httpMethod: 'GET',
          resourcePath: `/~1v1~1${path}`,
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: bootstrapReadBurstLimit.valueAsNumber,
          throttlingRateLimit: bootstrapReadRateLimit.valueAsNumber,
        })),
        {
          httpMethod: 'POST',
          resourcePath: '/~1v1~1sessions',
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: startSessionBurstLimit.valueAsNumber,
          throttlingRateLimit: startSessionRateLimit.valueAsNumber,
        },
        ...['debrief', 'timeline', 'playback'].map((path) => ({
          httpMethod: 'GET',
          resourcePath: `/~1v1~1sessions~1{id}~1${path}`,
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: 4,
          throttlingRateLimit: 2,
        })),
        {
          httpMethod: 'POST',
          resourcePath: '/~1v1~1sessions~1{id}~1end',
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: 8,
          throttlingRateLimit: 4,
        },
        {
          httpMethod: 'POST',
          resourcePath: '/~1v1~1sessions~1{id}~1hints',
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: 4,
          throttlingRateLimit: 2,
        },
        {
          httpMethod: 'GET',
          resourcePath: '/~1v1~1sessions~1{id}',
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: sessionStatusBurstLimit.valueAsNumber,
          throttlingRateLimit: sessionStatusRateLimit.valueAsNumber,
        },
        {
          httpMethod: 'POST',
          // API Gateway method settings use JSON Pointer escaping for path separators.
          resourcePath: '/~1v1~1sessions~1{id}~1terminal-tickets',
          cachingEnabled: false,
          dataTraceEnabled: false,
          metricsEnabled: true,
          throttlingBurstLimit: terminalTicketBurstLimit.valueAsNumber,
          throttlingRateLimit: terminalTicketRateLimit.valueAsNumber,
        },
      ],
    });
    terminalTicketStage.cfnOptions.condition = gatewayEnabled;

    const publishLogs = new LogGroup(this, 'PublishRecordingWorkLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const publishRole = new Role(this, 'PublishRecordingWorkRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    });
    publishLogs.grantWrite(publishRole);
    publishRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      }),
    );
    const publish = new Function(this, 'PublishRecordingWork', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/publish-recording-work/', import.meta.url))),
      role: publishRole,
      logGroup: publishLogs,
      environment: { SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: Fn.conditionIf(gatewayEnabled.logicalId, 4, 0) as unknown as number,
    });
    const publishDeadLetters = new Queue(this, 'PublishRecordingWorkDeadLetters', {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.seconds(30),
    });
    publish.configureAsyncInvoke({
      retryAttempts: 2,
      maxEventAge: Duration.minutes(2),
      onFailure: new SqsDestination(publishDeadLetters),
    });
    new Alarm(this, 'PublishRecordingWorkEventDropped', {
      metric: publish.metric('AsyncEventsDropped', { statistic: 'Sum', period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A task-state event was dropped before recording work was published.',
    });
    new Alarm(this, 'PublishRecordingWorkDeadLettersVisible', {
      metric: publishDeadLetters.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
      alarmDescription: 'A task-state event exhausted recording-work publication retries.',
    });
    const taskStateRule = new Rule(this, 'RecordRunningEnvironmentTask', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Task State Change'],
        detail: { clusterArn: [clusterArn.valueAsString], lastStatus: ['RUNNING'] },
      },
    });
    const taskStateCfnRule = taskStateRule.node.defaultChild as CfnRule;
    taskStateCfnRule.state = Fn.conditionIf(gatewayEnabled.logicalId, 'ENABLED', 'DISABLED') as unknown as string;
    taskStateRule.addTarget(
      new LambdaFunction(publish, {
        retryAttempts: 2,
        maxEventAge: Duration.minutes(2),
        deadLetterQueue: publishDeadLetters,
      }),
    );

    const gatewayLogs = new LogGroup(this, 'GatewayLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const gatewayExecutionRole = new Role(this, 'GatewayExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    gatewayLogs.grantWrite(gatewayExecutionRole);
    gatewayExecutionRole.addToPolicy(new PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    const gatewayRepositoryArn = Stack.of(this).formatArn({
      service: 'ecr',
      resource: 'repository',
      resourceName: 'opsreplay-gateway',
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    gatewayExecutionRole.addToPolicy(
      new PolicyStatement({
        actions: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: [gatewayRepositoryArn],
      }),
    );

    const gatewayRole = new Role(this, 'GatewayRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: [
          'dynamodb:BatchGetItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:DeleteItem',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
          'dynamodb:TransactGetItems',
          'dynamodb:UpdateItem',
        ],
        resources: [table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*'] } },
      }),
    );
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${table.tableArn}/index/${unfinishedWorkIndex.name}`],
        conditions: {
          'ForAllValues:StringEquals': {
            'dynamodb:LeadingKeys': [unfinishedWorkIndex.recordingPartition],
          },
        },
      }),
    );
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [recordings.arnForObjects('sessions/*/terminal/*/live/*')],
      }),
    );
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['s3:PutObject', 's3:PutObjectTagging'],
        resources: [recordings.arnForObjects('sessions/*')],
        conditions: {
          StringEquals: {
            [`s3:RequestObjectTag/${recordingRetention.tagKey}`]: [
              recordingRetention.provisionalTagValue,
              recordingRetention.sealedTagValue,
            ],
          },
          'ForAllValues:StringEquals': { 's3:RequestObjectTagKeys': [recordingRetention.tagKey] },
        },
      }),
    );
    gatewayRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['s3:PutObjectTagging'],
        resources: [recordings.arnForObjects('sessions/*')],
        conditions: {
          Null: { [`s3:ExistingObjectTag/${recordingRetention.tagKey}`]: 'false' },
        },
      }),
    );

    const terminalLoadBalancer = new CfnLoadBalancer(this, 'TerminalLoadBalancer', {
      type: 'application',
      scheme: 'internal',
      ipAddressType: 'ipv4',
      subnets: subnetIds.valueAsList,
      securityGroups: [loadBalancerSecurityGroup.attrGroupId],
      loadBalancerAttributes: [
        { key: 'idle_timeout.timeout_seconds', value: '60' },
        { key: 'routing.http.drop_invalid_header_fields.enabled', value: 'true' },
      ],
    });
    terminalLoadBalancer.cfnOptions.condition = gatewayEnabled;
    const terminalTargetGroup = new CfnTargetGroup(this, 'TerminalGatewayTargetGroup', {
      vpcId: vpcId.valueAsString,
      targetType: 'ip',
      ipAddressType: 'ipv4',
      protocol: 'HTTP',
      protocolVersion: 'HTTP1',
      port: gatewayPort,
      healthCheckEnabled: true,
      healthCheckProtocol: 'HTTP',
      healthCheckPort: 'traffic-port',
      healthCheckPath: '/healthz',
      healthCheckIntervalSeconds: 30,
      healthCheckTimeoutSeconds: 5,
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 2,
      matcher: { httpCode: '200' },
      targetGroupAttributes: [
        { key: 'deregistration_delay.timeout_seconds', value: '30' },
        { key: 'stickiness.enabled', value: 'false' },
      ],
    });
    terminalTargetGroup.cfnOptions.condition = gatewayEnabled;
    const terminalListener = new CfnListener(this, 'TerminalHttpListener', {
      loadBalancerArn: terminalLoadBalancer.ref,
      port: 80,
      protocol: 'HTTP',
      defaultActions: [
        {
          type: 'fixed-response',
          fixedResponseConfig: { statusCode: '404', contentType: 'text/plain', messageBody: 'Not found' },
        },
      ],
    });
    terminalListener.cfnOptions.condition = gatewayEnabled;
    const terminalListenerRule = new CfnListenerRule(this, 'TerminalWebSocketRoute', {
      listenerArn: terminalListener.ref,
      priority: 1,
      conditions: [{ field: 'path-pattern', pathPatternConfig: { values: ['/v1/terminal'] } }],
      actions: [{ type: 'forward', targetGroupArn: terminalTargetGroup.ref }],
    });
    terminalListenerRule.cfnOptions.condition = gatewayEnabled;

    const terminalVpcOrigin = new CfnVpcOrigin(this, 'TerminalVpcOrigin', {
      vpcOriginEndpointConfig: {
        arn: terminalLoadBalancer.ref,
        name: Fn.join('-', [Aws.STACK_NAME, 'terminal']),
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: 'http-only',
      },
    });
    terminalVpcOrigin.cfnOptions.condition = gatewayEnabled;
    // CloudFront requires an active origin. Create its listener and route first.
    terminalVpcOrigin.addResourceDependency(terminalListenerRule);
    const terminalOriginRequestPolicy = new CfnOriginRequestPolicy(this, 'TerminalOriginRequestPolicy', {
      originRequestPolicyConfig: {
        name: Fn.join('-', [Aws.STACK_NAME, 'terminal-websocket']),
        headersConfig: {
          headerBehavior: 'whitelist',
          headers: [
            'Origin',
            'Sec-WebSocket-Key',
            'Sec-WebSocket-Version',
            'Sec-WebSocket-Protocol',
            'Sec-WebSocket-Accept',
            'Sec-WebSocket-Extensions',
          ],
        },
        cookiesConfig: { cookieBehavior: 'none' },
        // Preserve query strings so the Gateway can reject URLs that contain them.
        queryStringsConfig: { queryStringBehavior: 'all' },
      },
    });
    terminalOriginRequestPolicy.cfnOptions.condition = gatewayEnabled;
    const terminalDistribution = new CfnDistribution(this, 'TerminalDistribution', {
      distributionConfig: {
        enabled: true,
        comment: 'OpsReplay private terminal ingress',
        httpVersion: 'http1.1',
        ipv6Enabled: true,
        viewerCertificate: { cloudFrontDefaultCertificate: true },
        webAclId: terminalEdgeWebAclArn.valueAsString,
        origins: [
          {
            id: 'terminal-gateway',
            domainName: terminalLoadBalancer.attrDnsName,
            connectionAttempts: 1,
            connectionTimeout: 10,
            vpcOriginConfig: {
              vpcOriginId: terminalVpcOrigin.attrId,
              originReadTimeout: 30,
              originKeepaliveTimeout: 5,
            },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'terminal-gateway',
          viewerProtocolPolicy: 'https-only',
          allowedMethods: ['GET', 'HEAD'],
          cachedMethods: ['GET', 'HEAD'],
          cachePolicyId: CachePolicy.CACHING_DISABLED.cachePolicyId,
          originRequestPolicyId: terminalOriginRequestPolicy.ref,
          compress: false,
        },
        customErrorResponses: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504].map((errorCode) => ({
          errorCode,
          errorCachingMinTtl: 0,
        })),
      },
    });
    terminalDistribution.cfnOptions.condition = gatewayEnabled;
    const terminalGatewayUrl = Fn.join('', ['wss://', terminalDistribution.attrDomainName, '/v1/terminal']);
    // Do not reference an absent conditional distribution when the runtime is disabled.
    terminalTicket.addEnvironment(
      'TERMINAL_GATEWAY_URL',
      Fn.conditionIf(gatewayEnabled.logicalId, terminalGatewayUrl, '').toString(),
    );

    const gatewayImage = Fn.join('', [
      Aws.ACCOUNT_ID,
      '.dkr.ecr.',
      Aws.REGION,
      '.',
      Aws.URL_SUFFIX,
      '/opsreplay-gateway@',
      gatewayImageDigest.valueAsString,
    ]);
    const gatewayTask = new CfnTaskDefinition(this, 'GatewayTask', {
      family: 'opsreplay-gateway',
      cpu: '512',
      memory: '1024',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      executionRoleArn: gatewayExecutionRole.roleArn,
      taskRoleArn: gatewayRole.roleArn,
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      containerDefinitions: [
        {
          name: 'gateway',
          image: gatewayImage,
          essential: true,
          readonlyRootFilesystem: true,
          user: 'node',
          stopTimeout: 30,
          linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
          portMappings: [{ name: 'terminal-websocket', containerPort: gatewayPort, protocol: 'tcp' }],
          environment: [
            { name: 'SESSION_TABLE_NAME', value: table.tableName },
            { name: 'RECORDING_BUCKET_NAME', value: recordings.bucketName },
            { name: 'MAXIMUM_CONCURRENT_RECORDINGS', value: gatewayRecordingCapacity.valueAsString },
            { name: 'MONITOR_PORT', value: '9443' },
            { name: 'GATEWAY_PORT', value: String(gatewayPort) },
            { name: 'TERMINAL_ALLOWED_ORIGINS', value: terminalAllowedOrigins.valueAsString },
            { name: 'MAXIMUM_TERMINAL_CONNECTIONS', value: String(maximumTerminalConnections) },
            {
              name: 'MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS',
              value: String(maximumPendingTerminalAuthentications),
            },
            { name: 'TERMINAL_PORT', value: String(terminalPort) },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': gatewayLogs.logGroupName,
              'awslogs-region': Aws.REGION,
              'awslogs-stream-prefix': 'gateway',
            },
          },
        },
      ],
    });
    gatewayTask.cfnOptions.condition = gatewayEnabled;
    const gatewayService = new CfnService(this, 'GatewayService', {
      cluster: clusterArn.valueAsString,
      taskDefinition: gatewayTask.ref,
      desiredCount: gatewayDesiredCount.valueAsNumber,
      launchType: 'FARGATE',
      platformVersion: '1.4.0',
      availabilityZoneRebalancing: 'ENABLED',
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: true },
        maximumPercent: 200,
        minimumHealthyPercent: 100,
      },
      enableEcsManagedTags: true,
      enableExecuteCommand: false,
      propagateTags: 'TASK_DEFINITION',
      healthCheckGracePeriodSeconds: 30,
      loadBalancers: [
        {
          targetGroupArn: terminalTargetGroup.ref,
          containerName: 'gateway',
          containerPort: gatewayPort,
        },
      ],
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'DISABLED',
          securityGroups: [gatewaySecurityGroup.attrGroupId],
          subnets: subnetIds.valueAsList,
        },
      },
    });
    gatewayService.cfnOptions.condition = gatewayEnabled;
    gatewayService.addResourceDependency(terminalListenerRule);
    gatewayService.addResourceDependency(monitorIngress);
    gatewayService.addResourceDependency(terminalIngress);
    gatewayService.addResourceDependency(awsEndpointIngress);

    for (const [id, value] of [
      ['RecordingBucketName', recordings.bucketName],
      ['MonitorBootstrapBucketName', secretFiles.bucketName],
      ['SessionTableName', table.tableName],
      ['SessionTableArn', table.tableArn],
      ['SessionTableStreamArn', table.tableStreamArn!],
      ['CognitoUserPoolId', userPoolId],
    ] as const) {
      const output = new CfnOutput(this, `${id}Output`, { value });
      output.overrideLogicalId(id);
    }
    new CfnOutput(this, 'GatewayServiceName', {
      value: gatewayService.attrName,
      condition: gatewayEnabled,
    });
    new CfnOutput(this, 'TerminalLoadBalancerDnsName', {
      value: terminalLoadBalancer.attrDnsName,
      condition: gatewayEnabled,
    });
    new CfnOutput(this, 'TerminalDistributionId', { value: terminalDistribution.ref, condition: gatewayEnabled });
    new CfnOutput(this, 'TerminalDistributionDomainName', {
      value: terminalDistribution.attrDomainName,
      condition: gatewayEnabled,
    });
    new CfnOutput(this, 'TerminalGatewayUrl', { value: terminalGatewayUrl, condition: gatewayEnabled });
    new CfnOutput(this, 'TerminalVpcOriginId', { value: terminalVpcOrigin.attrId, condition: gatewayEnabled });
    new CfnOutput(this, 'TerminalTicketApiUrl', {
      value: Fn.join('', [
        'https://',
        terminalApi.ref,
        '.execute-api.',
        Aws.REGION,
        '.',
        Aws.URL_SUFFIX,
        '/checkpoint',
      ]),
      condition: gatewayEnabled,
    });
    for (const [id, value] of [
      ['PublicApiAllowedOrigin', publicApiAllowedOrigin.valueAsString],
      ['BrowserCallbackUrl', browserCallbackUrl.valueAsString],
      ['BrowserLogoutUrl', browserLogoutUrl.valueAsString],
    ] as const) {
      const output = new CfnOutput(this, `${id}Output`, { value, condition: gatewayEnabled });
      output.overrideLogicalId(id);
    }
    for (const [id, value, condition] of [
      ['ManagedCognitoUserPoolClientId', managedUserPoolClient.ref, managedIdentity],
      [
        'ManagedCognitoLoginHostname',
        Fn.join('', [cognitoDomainPrefix.valueAsString, '.auth.', Aws.REGION, '.amazoncognito.com']),
        managedIdentity,
      ],
      [
        'ExternalCognitoUserPoolId',
        Fn.select(1, Fn.split('/', cognitoUserPoolArn.valueAsString)),
        externalIdentityEnabled,
      ],
      ['ExternalCognitoUserPoolClientId', cognitoUserPoolClientId.valueAsString, externalIdentityEnabled],
      ['ExternalCognitoLoginHostname', cognitoLoginHostname.valueAsString, externalIdentityEnabled],
    ] as const) {
      new CfnOutput(this, id, { value, condition });
    }
    new CfnOutput(this, 'EnvironmentMonitorSecurityGroup', {
      value: environmentMonitorSecurityGroupId.valueAsString,
    });
    new CfnOutput(this, 'GatewaySecurityGroupId', { value: gatewaySecurityGroup.attrGroupId });
    // Session start remains disabled. The complete Gateway path is also disabled unless explicitly enabled.
  }
}
