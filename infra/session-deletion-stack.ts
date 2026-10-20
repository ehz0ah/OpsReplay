import { fileURLToPath } from 'node:url';
import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

/** Explicit IAM invocation only. This stack owns no learner data or public route. */
export class SessionDeletionStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const table = new CfnParameter(this, 'SessionTableName', {
      type: 'String',
      allowedPattern: '[A-Za-z0-9_.-]{3,255}',
    });
    const bucket = new CfnParameter(this, 'RecordingBucketName', {
      type: 'String',
      allowedPattern: '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',
    });
    const enabled = new CfnParameter(this, 'EnableSessionDeletion', {
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
    });
    const active = new CfnCondition(this, 'SessionDeletionEnabled', {
      expression: Fn.conditionEquals(enabled.valueAsString, 'true'),
    });
    const action = new Function(this, 'DeleteSession', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(fileURLToPath(new URL('../dist/delete-session', import.meta.url))),
      environment: { SESSION_TABLE_NAME: table.valueAsString, RECORDING_BUCKET_NAME: bucket.valueAsString },
      timeout: Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: Fn.conditionIf(active.logicalId, 1, 0) as unknown as number,
      logGroup: new LogGroup(this, 'DeleteSessionLogs', {
        retention: RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    action.addToRolePolicy(
      new PolicyStatement({
        actions: [
          'dynamodb:GetItem',
          'dynamodb:Query',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:ConditionCheckItem',
        ],
        resources: [`arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${table.valueAsString}`],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['SESSION#*', 'USER#*'] } },
      }),
    );
    action.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:GetBucketVersioning'],
        resources: [`arn:${Aws.PARTITION}:s3:::${bucket.valueAsString}`],
      }),
    );
    action.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:${Aws.PARTITION}:s3:::${bucket.valueAsString}`],
        conditions: { StringLike: { 's3:prefix': ['sessions/*/'] } },
      }),
    );
    action.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:DeleteObject'],
        resources: [`arn:${Aws.PARTITION}:s3:::${bucket.valueAsString}/sessions/*`],
      }),
    );
    new CfnOutput(this, 'DeleteSessionFunctionArn', { value: action.functionArn });
  }
}
