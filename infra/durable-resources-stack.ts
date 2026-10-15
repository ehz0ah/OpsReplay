import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import { CfnUserPool } from 'aws-cdk-lib/aws-cognito';
import { AttributeType, BillingMode, ProjectionType, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { unfinishedWorkIndex } from '../packages/contracts/private/recording-work.js';
import { recordingRetention } from '../packages/contracts/private/recording-retention.js';
import { terminalTicketTtlAttribute } from '../packages/contracts/private/terminal-access.js';

export interface DurableResourceNames {
  sessionTable: string;
  monitorBootstrapBucket: string;
  recordingBucket: string;
  cognitoUserPool: string;
}

export interface DurableResourcesStackProps extends StackProps {
  resourceNames: DurableResourceNames;
}

const durableResourceContextKeys: Record<keyof DurableResourceNames, string> = {
  sessionTable: 'durableSessionTableName',
  monitorBootstrapBucket: 'durableMonitorBootstrapBucketName',
  recordingBucket: 'durableRecordingBucketName',
  cognitoUserPool: 'durableCognitoUserPoolName',
};

export function durableResourceNamesFromContext(
  getContext: (key: string) => unknown,
): DurableResourceNames | undefined {
  const values = Object.fromEntries(
    Object.entries(durableResourceContextKeys).map(([name, key]) => [name, getContext(key)]),
  ) as Record<keyof DurableResourceNames, unknown>;
  const entries = Object.entries(values) as [keyof DurableResourceNames, unknown][];
  if (entries.every(([, value]) => value === undefined)) return undefined;

  const invalid = entries
    .filter(([, value]) => typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    .map(([name]) => durableResourceContextKeys[name]);
  if (invalid.length > 0) {
    throw new Error(`Durable resource context requires all four non-empty exact names; invalid: ${invalid.join(', ')}`);
  }
  return values as DurableResourceNames;
}

export class DurableResourcesStack extends Stack {
  constructor(scope: Construct, id: string, props: DurableResourcesStackProps) {
    const { resourceNames, ...stackProps } = props;
    super(scope, id, stackProps);

    this.templateOptions.description =
      'Long-lived OpsReplay data and learner identity. Import retained resources before normal deployment.';

    const table = new Table(this, 'Sessions', {
      tableName: resourceNames.sessionTable,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.KEYS_ONLY,
      timeToLiveAttribute: terminalTicketTtlAttribute,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: unfinishedWorkIndex.name,
      partitionKey: { name: unfinishedWorkIndex.partitionKey, type: AttributeType.STRING },
      sortKey: { name: unfinishedWorkIndex.sortKey, type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    const secretFiles = new Bucket(this, 'MonitorSecretFiles', {
      bucketName: resourceNames.monitorBootstrapBucket,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'sessions/', expiration: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const recordings = new Bucket(this, 'Recordings', {
      bucketName: resourceNames.recordingBucket,
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
    for (const bucket of [secretFiles, recordings]) {
      const policy = bucket.policy;
      if (!policy) throw new Error(`TLS policy was not created for ${bucket.node.path}`);
      policy.applyRemovalPolicy(RemovalPolicy.RETAIN);
    }

    const userPool = new CfnUserPool(this, 'UserPool', {
      userPoolName: resourceNames.cognitoUserPool,
      adminCreateUserConfig: { allowAdminCreateUserOnly: true },
      autoVerifiedAttributes: ['email'],
      usernameAttributes: ['email'],
      usernameConfiguration: { caseSensitive: false },
      accountRecoverySetting: { recoveryMechanisms: [{ name: 'verified_email', priority: 1 }] },
      deletionProtection: 'ACTIVE',
    });
    userPool.applyRemovalPolicy(RemovalPolicy.RETAIN);

    for (const [outputId, value, description] of [
      ['SessionTableName', table.tableName, 'Durable session table name.'],
      ['SessionTableArn', table.tableArn, 'Durable session table ARN.'],
      ['SessionTableStreamArn', table.tableStreamArn!, 'Durable session table stream ARN.'],
      ['MonitorBootstrapBucketName', secretFiles.bucketName, 'Durable Monitor bootstrap-file bucket name.'],
      ['MonitorBootstrapBucketArn', secretFiles.bucketArn, 'Durable Monitor bootstrap-file bucket ARN.'],
      ['RecordingBucketName', recordings.bucketName, 'Durable recording bucket name.'],
      ['RecordingBucketArn', recordings.bucketArn, 'Durable recording bucket ARN.'],
      ['CognitoUserPoolId', userPool.ref, 'Durable learner user pool ID.'],
      ['CognitoUserPoolArn', userPool.attrArn, 'Durable learner user pool ARN.'],
    ] as const) {
      const output = new CfnOutput(this, `${outputId}Output`, { value, description });
      output.overrideLogicalId(outputId);
    }
  }
}
