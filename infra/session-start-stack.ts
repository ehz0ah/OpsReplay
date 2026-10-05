import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export class SessionStartStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const table = new Table(this, 'Sessions', {
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // Safe default. A disposable deployment must explicitly decide what data to remove.
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logs = new LogGroup(this, 'StartLogs', {
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new Role(this, 'StartRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    logs.grantWrite(role);
    role.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
      resources: [table.tableArn],
    }));
    role.addToPolicy(new PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [table.tableArn],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'SESSION#*'] } },
    }));
    new Function(this, 'StartSession', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/start-session/', import.meta.url))),
      role,
      logGroup: logs,
      environment: { SESSION_TABLE_NAME: table.tableName },
      memorySize: 256,
      timeout: Duration.seconds(10),
      // Admission is incomplete without task launch and cleanup. Do not enable it yet.
      reservedConcurrentExecutions: 0,
    });
    // No route, URL, event source, network, or invoke permission in this increment.
  }
}
