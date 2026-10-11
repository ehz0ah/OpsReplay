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
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Alarm, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnSecurityGroup, CfnSecurityGroupEgress, CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import { CfnService, CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { CfnListener, CfnListenerRule, CfnLoadBalancer, CfnTargetGroup } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CfnRule, Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { ArnPrincipal, Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnPermission, CfnEventSourceMapping, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsDestination } from 'aws-cdk-lib/aws-lambda-destinations';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import { unfinishedWorkIndex } from '../packages/contracts/private/recording-work.js';
import { lifecycleHintPrefix } from '../packages/contracts/private/lifecycle-hint.js';
import { recordingRetention } from '../packages/contracts/private/recording-retention.js';
import { terminalTicketTtlAttribute } from '../packages/contracts/private/terminal-access.js';

const gatewayPort = 8080;
const terminalPort = 7681;
const maximumTerminalConnections = 256;
const maximumPendingTerminalAuthentications = 64;
const terminalTicketApiDeploymentVersion = 4;
const terminalOriginHostPattern =
  '(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)';
const terminalOriginPortPattern =
  '(?::(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?';
const terminalOriginPattern = `https?://${terminalOriginHostPattern}${terminalOriginPortPattern}`;
const terminalAllowedOriginsPattern = `^(?:${terminalOriginPattern}(?:,${terminalOriginPattern}){0,15})?$`;

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
    const publicIngressSubnetIds = new CfnParameter(this, 'PublicIngressSubnetIds', {
      type: 'List<AWS::EC2::Subnet::Id>',
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
    const terminalUpgradeRateLimit = new CfnParameter(this, 'TerminalUpgradeRateLimitPerIp', {
      type: 'Number',
      default: 300,
      minValue: 10,
      maxValue: 2_000_000_000,
      description: 'Maximum terminal WebSocket upgrade requests per source IP in each 60-second WAF window.',
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
    const terminalCertificateArn = new CfnParameter(this, 'TerminalCertificateArn', {
      type: 'String',
      default: '',
      allowedPattern: '(|arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/[A-Za-z0-9-]+)',
    });
    const terminalAllowedOrigins = new CfnParameter(this, 'TerminalAllowedOrigins', {
      type: 'String',
      default: '',
      maxLength: 4096,
      allowedPattern: terminalAllowedOriginsPattern,
      description: 'Comma-separated exact HTTP or HTTPS web origins accepted by the Gateway.',
    });
    const terminalGatewayUrl = new CfnParameter(this, 'TerminalGatewayUrl', {
      type: 'String',
      default: '',
      maxLength: 500,
      allowedPattern: '(|wss://[^/?#]+/v1/terminal)',
    });
    const cognitoUserPoolArn = new CfnParameter(this, 'CognitoUserPoolArn', {
      type: 'String',
      default: '',
      allowedPattern: '(|arn:aws[a-z-]*:cognito-idp:[a-z0-9-]+:[0-9]{12}:userpool/[A-Za-z0-9_-]+)',
    });
    const gatewayPathEnabled = new CfnParameter(this, 'EnableGatewayPath', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
    });
    const gatewayEnabled = new CfnCondition(this, 'GatewayPathEnabled', {
      expression: Fn.conditionEquals(gatewayPathEnabled.valueAsString, 'true'),
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
          assert: Fn.conditionNot(Fn.conditionEquals(terminalCertificateArn.valueAsString, '')),
          assertDescription: 'TerminalCertificateArn is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(terminalAllowedOrigins.valueAsString, '')),
          assertDescription: 'TerminalAllowedOrigins is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(terminalGatewayUrl.valueAsString, '')),
          assertDescription: 'TerminalGatewayUrl is required when EnableGatewayPath is true.',
        },
        {
          assert: Fn.conditionNot(Fn.conditionEquals(cognitoUserPoolArn.valueAsString, '')),
          assertDescription: 'CognitoUserPoolArn is required when EnableGatewayPath is true.',
        },
      ],
    });
    const table = new Table(this, 'Sessions', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.KEYS_ONLY,
      timeToLiveAttribute: terminalTicketTtlAttribute,
      // Safe default. A disposable deployment must explicitly decide what data to remove.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: unfinishedWorkIndex.name,
      partitionKey: { name: unfinishedWorkIndex.partitionKey, type: AttributeType.STRING },
      sortKey: { name: unfinishedWorkIndex.sortKey, type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });
    const secretFiles = new Bucket(this, 'MonitorSecretFiles', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Each file bootstraps one task. ECS downloads it before starting the monitor.
      lifecycleRules: [{ prefix: 'sessions/', expiration: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const recordings = new Bucket(this, 'Recordings', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ExpireProvisionalRecordings',
          prefix: 'sessions/',
          tagFilters: { [recordingRetention.tagKey]: recordingRetention.provisionalTagValue },
          expiration: Duration.days(recordingRetention.provisionalDays),
        },
        {
          id: 'ExpireSealedRecordings',
          prefix: 'sessions/',
          tagFilters: { [recordingRetention.tagKey]: recordingRetention.sealedTagValue },
          expiration: Duration.days(recordingRetention.sealedDays),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

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
      groupDescription: 'Public HTTPS ingress for the OpsReplay terminal Gateway.',
      vpcId: vpcId.valueAsString,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          cidrIp: '0.0.0.0/0',
          description: 'Public terminal HTTPS and WebSocket traffic',
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
    // The ECS agent uses the execution role. Neither container receives AWS credentials.
    secretFiles.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ArnPrincipal(executionRoleArn.valueAsString)],
        actions: ['s3:GetObject'],
        resources: [secretFiles.arnForObjects('sessions/*')],
      }),
    );
    secretFiles.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ArnPrincipal(executionRoleArn.valueAsString)],
        actions: ['s3:GetBucketLocation'],
        resources: [secretFiles.bucketArn],
      }),
    );
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
    const lifecycleFunction = (id: string, bundle: string, timeout: number) => {
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
        reservedConcurrentExecutions: 0,
      });
    };
    const reconcileSession = lifecycleFunction('ReconcileSession', 'reconcile-session', 30);
    const sweepSessions = lifecycleFunction('SweepSessions', 'sweep-sessions', 60);
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
          resources: [recordings.arnForObjects('sessions/*/metrics/*/sealed/*')],
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
      enabled: false,
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
    new Function(this, 'StartSession', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/start-session/', import.meta.url))),
      role,
      logGroup: logs,
      environment: {
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
      // Admission is incomplete without task launch and cleanup. Do not enable it yet.
      reservedConcurrentExecutions: 0,
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
        SESSION_TABLE_NAME: table.tableName,
        TERMINAL_GATEWAY_URL: terminalGatewayUrl.valueAsString,
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
      environment: { SESSION_TABLE_NAME: table.tableName },
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
      environment: { SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: 0,
    });

    const terminalApi = new CfnRestApi(this, 'TerminalTicketApi', {
      name: 'opsreplay-terminal-ticket',
      description: 'Authenticated session-status and terminal-ticket actions for the bounded Gateway path.',
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
    const terminalApiSessions = new ApiGatewayResource(this, 'TerminalTicketApiSessions', {
      restApiId: terminalApi.ref,
      parentId: terminalApiV1.ref,
      pathPart: 'sessions',
    });
    terminalApiSessions.cfnOptions.condition = gatewayEnabled;
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
          'gatewayresponse.header.Cache-Control': "'no-store'",
          'gatewayresponse.header.Content-Type': "'application/json'",
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
        description: `Session-status and terminal-ticket routes version ${terminalTicketApiDeploymentVersion}.`,
      },
    );
    terminalTicketDeployment.cfnOptions.condition = gatewayEnabled;
    terminalTicketDeployment.addResourceDependency(terminalTicketMethod);
    terminalTicketDeployment.addResourceDependency(getSessionMethod);
    terminalTicketDeployment.addResourceDependency(endMethod);
    for (const response of terminalTicketGatewayResponses) {
      terminalTicketDeployment.addResourceDependency(response);
    }
    const terminalTicketStage = new CfnStage(this, 'TerminalTicketApiStage', {
      restApiId: terminalApi.ref,
      deploymentId: terminalTicketDeployment.ref,
      stageName: 'checkpoint',
      methodSettings: [
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
      scheme: 'internet-facing',
      ipAddressType: 'ipv4',
      subnets: publicIngressSubnetIds.valueAsList,
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
    const terminalListener = new CfnListener(this, 'TerminalHttpsListener', {
      loadBalancerArn: terminalLoadBalancer.ref,
      port: 443,
      protocol: 'HTTPS',
      sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
      certificates: [{ certificateArn: terminalCertificateArn.valueAsString }],
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

    const terminalWebAcl = new CfnWebACL(this, 'TerminalWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'opsreplay-terminal-web-acl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'terminal-connection-rate-limit',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              evaluationWindowSec: 60,
              limit: terminalUpgradeRateLimit.valueAsNumber,
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'EXACTLY',
                  searchString: '/v1/terminal',
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'opsreplay-terminal-connection-rate-limit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    terminalWebAcl.cfnOptions.condition = gatewayEnabled;
    const terminalWebAclAssociation = new CfnWebACLAssociation(this, 'TerminalWebAclAssociation', {
      resourceArn: terminalLoadBalancer.ref,
      webAclArn: terminalWebAcl.attrArn,
    });
    terminalWebAclAssociation.cfnOptions.condition = gatewayEnabled;

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

    new CfnOutput(this, 'RecordingBucketName', { value: recordings.bucketName });
    new CfnOutput(this, 'GatewayServiceName', {
      value: gatewayService.attrName,
      condition: gatewayEnabled,
    });
    new CfnOutput(this, 'TerminalLoadBalancerDnsName', {
      value: terminalLoadBalancer.attrDnsName,
      condition: gatewayEnabled,
    });
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
    new CfnOutput(this, 'EnvironmentMonitorSecurityGroup', {
      value: environmentMonitorSecurityGroupId.valueAsString,
    });
    new CfnOutput(this, 'GatewaySecurityGroupId', { value: gatewaySecurityGroup.attrGroupId });
    // Session start remains disabled. The complete Gateway path is also disabled unless explicitly enabled.
  }
}
