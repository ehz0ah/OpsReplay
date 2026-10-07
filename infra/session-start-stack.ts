import { fileURLToPath } from 'node:url';
import { ArnFormat, CfnParameter, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Alarm, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { ArnPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

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
    const securityGroupIds = new CfnParameter(this, 'EnvironmentSecurityGroupIds', {
      type: 'List<AWS::EC2::SecurityGroup::Id>',
    });
    const executionRoleArn = new CfnParameter(this, 'EnvironmentExecutionRoleArn', {
      type: 'String',
      allowedPattern: 'arn:aws[a-z-]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+',
    });
    const table = new Table(this, 'Sessions', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Safe default. A disposable deployment must explicitly decide what data to remove.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const secretFiles = new Bucket(this, 'MonitorSecretFiles', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Each file bootstraps one task. ECS downloads it before starting the monitor.
      lifecycleRules: [{ prefix: 'sessions/', expiration: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
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
        actions: ['s3:GetObject', 's3:PutObject'],
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
        ECS_SECURITY_GROUP_IDS: Fn.join(',', securityGroupIds.valueAsList),
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
    // No route, URL, event source, network, or enabled function exists in this increment.
  }
}
