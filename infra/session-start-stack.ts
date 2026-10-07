import { fileURLToPath } from 'node:url';
import { ArnFormat, Aws, CfnCondition, CfnOutput, CfnParameter, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, ProjectionType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Alarm, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { CfnSecurityGroup, CfnSecurityGroupIngress } from 'aws-cdk-lib/aws-ec2';
import { CfnService, CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { CfnRule, Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { ArnPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { SqsDestination } from 'aws-cdk-lib/aws-lambda-destinations';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { unfinishedWorkIndex } from '../packages/contracts/private/recording-work.js';

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
    const vpcId = new CfnParameter(this, 'EnvironmentVpcId', {
      type: 'AWS::EC2::VPC::Id',
    });
    const environmentMonitorSecurityGroupId = new CfnParameter(this, 'EnvironmentMonitorSecurityGroupId', {
      type: 'AWS::EC2::SecurityGroup::Id',
    });
    const executionRoleArn = new CfnParameter(this, 'EnvironmentExecutionRoleArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+',
    });
    const gatewayImageDigest = new CfnParameter(this, 'GatewayImageDigest', {
      type: 'String',
      allowedPattern: 'sha256:[a-f0-9]{64}',
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
    const recordingPathEnabled = new CfnParameter(this, 'EnableRecordingPath', {
      type: 'String',
      default: 'false',
      allowedValues: ['false', 'true'],
    });
    const recordingEnabled = new CfnCondition(this, 'RecordingPathEnabled', {
      expression: Fn.conditionEquals(recordingPathEnabled.valueAsString, 'true'),
    });
    const table = new Table(this, 'Sessions', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
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
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const gatewaySecurityGroup = new CfnSecurityGroup(this, 'GatewaySecurityGroup', {
      groupDescription: 'OpsReplay gateway recording tasks. No inbound listener in this increment.',
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [
        {
          ipProtocol: 'tcp',
          fromPort: 9443,
          toPort: 9443,
          destinationSecurityGroupId: environmentMonitorSecurityGroupId.valueAsString,
          description: 'Authenticated monitor control',
        },
        { ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: '0.0.0.0/0', description: 'Private AWS endpoints' },
        { ipProtocol: 'tcp', fromPort: 53, toPort: 53, cidrIp: '0.0.0.0/0', description: 'VPC DNS' },
        { ipProtocol: 'udp', fromPort: 53, toPort: 53, cidrIp: '0.0.0.0/0', description: 'VPC DNS' },
      ],
    });
    const monitorIngress = new CfnSecurityGroupIngress(this, 'MonitorIngress', {
      groupId: environmentMonitorSecurityGroupId.valueAsString,
      sourceSecurityGroupId: gatewaySecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 9443,
      toPort: 9443,
      description: 'Gateway to monitor control',
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
    role.addToPolicy(
      new PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:GetSchedule'],
        resources: [scheduleArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [schedulerRole.roleArn],
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
        ECS_SECURITY_GROUP_IDS: environmentMonitorSecurityGroupId.valueAsString,
        ECS_PLATFORM_VERSION: '1.4.0',
        MONITOR_CONTAINER_NAME: 'monitor',
        MONITOR_SECRET_BUCKET_ARN: secretFiles.bucketArn,
        SCHEDULER_GROUP_NAME: scheduleGroup.ref,
        PROVISIONING_EXPIRY_FUNCTION_ARN: expiry.functionArn,
        SCHEDULER_TARGET_ROLE_ARN: schedulerRole.roleArn,
      },
      memorySize: 256,
      timeout: Duration.seconds(20),
      // Admission is incomplete without task launch and cleanup. Do not enable it yet.
      reservedConcurrentExecutions: 0,
    });

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
      reservedConcurrentExecutions: Fn.conditionIf(recordingEnabled.logicalId, 4, 0) as unknown as number,
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
    taskStateCfnRule.state = Fn.conditionIf(recordingEnabled.logicalId, 'ENABLED', 'DISABLED') as unknown as string;
    taskStateRule.addTarget(
      new LambdaFunction(publish, {
        retryAttempts: 2,
        maxEventAge: Duration.minutes(2),
        deadLetterQueue: publishDeadLetters,
      }),
    );

    const gatewayLogs = new LogGroup(this, 'GatewayRecordingLogs', {
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

    const gatewayRole = new Role(this, 'GatewayRecordingRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    gatewayRole.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
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
      new PolicyStatement({ actions: ['s3:PutObject'], resources: [recordings.arnForObjects('sessions/*')] }),
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
    const gatewayTask = new CfnTaskDefinition(this, 'GatewayRecordingTask', {
      family: 'opsreplay-gateway-recording',
      cpu: '512',
      memory: '1024',
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      executionRoleArn: gatewayExecutionRole.roleArn,
      taskRoleArn: gatewayRole.roleArn,
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      containerDefinitions: [
        {
          name: 'gateway-recording',
          image: gatewayImage,
          essential: true,
          readonlyRootFilesystem: true,
          user: 'node',
          stopTimeout: 30,
          linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
          environment: [
            { name: 'SESSION_TABLE_NAME', value: table.tableName },
            { name: 'RECORDING_BUCKET_NAME', value: recordings.bucketName },
            { name: 'MAXIMUM_CONCURRENT_RECORDINGS', value: gatewayRecordingCapacity.valueAsString },
            { name: 'MONITOR_PORT', value: '9443' },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: {
              'awslogs-group': gatewayLogs.logGroupName,
              'awslogs-region': Aws.REGION,
              'awslogs-stream-prefix': 'gateway-recording',
            },
          },
        },
      ],
    });
    const gatewayService = new CfnService(this, 'GatewayRecordingService', {
      cluster: clusterArn.valueAsString,
      taskDefinition: gatewayTask.ref,
      desiredCount: Fn.conditionIf(
        recordingEnabled.logicalId,
        gatewayDesiredCount.valueAsNumber,
        0,
      ) as unknown as number,
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
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: 'DISABLED',
          securityGroups: [gatewaySecurityGroup.attrGroupId],
          subnets: subnetIds.valueAsList,
        },
      },
    });
    gatewayService.addResourceDependency(monitorIngress);

    new CfnOutput(this, 'RecordingBucketName', { value: recordings.bucketName });
    new CfnOutput(this, 'GatewayRecordingServiceName', { value: gatewayService.attrName });
    new CfnOutput(this, 'EnvironmentMonitorSecurityGroup', {
      value: environmentMonitorSecurityGroupId.valueAsString,
    });
    new CfnOutput(this, 'GatewaySecurityGroupId', { value: gatewaySecurityGroup.attrGroupId });
    // Session start remains disabled. No public route or terminal listener exists in this increment.
  }
}
