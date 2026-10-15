import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DurableResourcesStack, durableResourceNamesFromContext } from './durable-resources-stack.js';

type Resource = {
  Type: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties?: Record<string, any>;
};

test('durable resource context is absent or complete', () => {
  const resolve = (values: Record<string, unknown>) => durableResourceNamesFromContext((key) => values[key]);
  assert.equal(resolve({}), undefined);
  assert.throws(
    () => resolve({ durableSessionTableName: 'opsreplay-sessions' }),
    /requires all four non-empty exact names/,
  );
  assert.throws(
    () =>
      resolve({
        durableSessionTableName: 'opsreplay-sessions',
        durableMonitorBootstrapBucketName: ' opsreplay-monitor-bootstrap ',
        durableRecordingBucketName: 'opsreplay-recordings',
        durableCognitoUserPoolName: 'opsreplay-users',
      }),
    /durableMonitorBootstrapBucketName/,
  );
  assert.deepEqual(
    resolve({
      durableSessionTableName: 'opsreplay-sessions',
      durableMonitorBootstrapBucketName: 'opsreplay-monitor-bootstrap',
      durableRecordingBucketName: 'opsreplay-recordings',
      durableCognitoUserPoolName: 'opsreplay-users',
    }),
    {
      sessionTable: 'opsreplay-sessions',
      monitorBootstrapBucket: 'opsreplay-monitor-bootstrap',
      recordingBucket: 'opsreplay-recordings',
      cognitoUserPool: 'opsreplay-users',
    },
  );
});

test('the durable stack owns only retained state and its storage controls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-durable-resources-'));
  try {
    const rendered = Template.fromStack(
      new DurableResourcesStack(new App({ outdir: directory }), 'TestDurableResources', {
        resourceNames: {
          sessionTable: 'opsreplay-retained-sessions',
          monitorBootstrapBucket: 'opsreplay-retained-monitor-bootstrap',
          recordingBucket: 'opsreplay-retained-recordings',
          cognitoUserPool: 'opsreplay-retained-users',
        },
      }),
    ).toJSON() as {
      Parameters: Record<string, Record<string, unknown>>;
      Resources: Record<string, Resource>;
      Outputs: Record<string, Record<string, unknown>>;
    };
    const resources = Object.entries(rendered.Resources);
    const ofType = (type: string) => resources.filter(([, resource]) => resource.Type === type);

    assert.deepEqual(Object.keys(rendered.Parameters).sort(), ['BootstrapVersion', 'BrowserAllowedOrigin'].sort());

    const [table] = ofType('AWS::DynamoDB::Table');
    assert.ok(table);
    assert.equal(table[1].DeletionPolicy, 'Retain');
    assert.equal(table[1].UpdateReplacePolicy, 'Retain');
    assert.deepEqual(table[1].Properties, {
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
        { AttributeName: 'WorkPK', AttributeType: 'S' },
        { AttributeName: 'WorkSK', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      DeletionProtectionEnabled: true,
      GlobalSecondaryIndexes: [
        {
          IndexName: 'unfinished-work',
          KeySchema: [
            { AttributeName: 'WorkPK', KeyType: 'HASH' },
            { AttributeName: 'WorkSK', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      StreamSpecification: { StreamViewType: 'KEYS_ONLY' },
      TableName: 'opsreplay-retained-sessions',
      TimeToLiveSpecification: { AttributeName: 'ExpiresAt', Enabled: true },
    });

    const buckets = ofType('AWS::S3::Bucket');
    assert.equal(buckets.length, 2);
    for (const [, bucket] of buckets) {
      assert.equal(bucket.DeletionPolicy, 'Retain');
      assert.equal(bucket.UpdateReplacePolicy, 'Retain');
      assert.deepEqual(bucket.Properties?.BucketEncryption, {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      });
      assert.deepEqual(bucket.Properties?.PublicAccessBlockConfiguration, {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
    const secretBucket = buckets.find(
      ([, bucket]) => bucket.Properties?.BucketName === 'opsreplay-retained-monitor-bootstrap',
    );
    const recordingBucket = buckets.find(
      ([, bucket]) => bucket.Properties?.BucketName === 'opsreplay-retained-recordings',
    );
    assert.ok(secretBucket && recordingBucket);
    assert.equal(rendered.Parameters.BrowserAllowedOrigin!.Default, '');
    assert.deepEqual(recordingBucket[1].Properties?.CorsConfiguration, {
      'Fn::If': [
        'BrowserPlaybackCorsEnabled',
        { CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: [{ Ref: 'BrowserAllowedOrigin' }], MaxAge: 300 }] },
        { Ref: 'AWS::NoValue' },
      ],
    });
    assert.equal(secretBucket[1].Properties?.CorsConfiguration, undefined);
    assert.deepEqual(secretBucket[1].Properties?.LifecycleConfiguration, {
      Rules: [{ ExpirationInDays: 1, Prefix: 'sessions/', Status: 'Enabled' }],
    });
    assert.deepEqual(recordingBucket[1].Properties?.LifecycleConfiguration, {
      Rules: [
        {
          ExpirationInDays: 7,
          Id: 'ExpireProvisionalRecordings',
          Prefix: 'sessions/',
          Status: 'Enabled',
          TagFilters: [{ Key: 'opsreplay-retention', Value: 'provisional' }],
        },
        {
          ExpirationInDays: 30,
          Id: 'ExpireSealedRecordings',
          Prefix: 'sessions/',
          Status: 'Enabled',
          TagFilters: [{ Key: 'opsreplay-retention', Value: 'sealed' }],
        },
      ],
    });

    const bucketPolicies = ofType('AWS::S3::BucketPolicy');
    assert.equal(bucketPolicies.length, 2);
    for (const [, policy] of bucketPolicies) {
      assert.equal(policy.DeletionPolicy, 'Retain');
      assert.equal(policy.UpdateReplacePolicy, 'Retain');
      const policyDocument = policy.Properties?.PolicyDocument;
      assert.ok(policyDocument);
      const statements = (policyDocument as { Statement: Record<string, unknown>[] }).Statement;
      assert.equal(statements.length, 1);
      assert.deepEqual(statements[0]?.Action, 's3:*');
      assert.deepEqual(statements[0]?.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
      assert.equal(statements[0]?.Effect, 'Deny');
      assert.deepEqual(statements[0]?.Principal, { AWS: '*' });
      assert.equal(JSON.stringify(statements[0]?.Resource).includes('sessions/*'), false);
    }

    const [userPool] = ofType('AWS::Cognito::UserPool');
    assert.ok(userPool);
    assert.equal(userPool[1].DeletionPolicy, 'Retain');
    assert.equal(userPool[1].UpdateReplacePolicy, 'Retain');
    assert.deepEqual(userPool[1].Properties, {
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      AutoVerifiedAttributes: ['email'],
      DeletionProtection: 'ACTIVE',
      UserPoolName: 'opsreplay-retained-users',
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
    });
    assert.equal(ofType('AWS::Cognito::UserPoolClient').length, 0);
    assert.equal(ofType('AWS::Cognito::UserPoolDomain').length, 0);
    assert.equal(ofType('AWS::IAM::Role').length, 0);
    assert.deepEqual(Object.keys(rendered.Outputs).sort(), [
      'CognitoUserPoolArn',
      'CognitoUserPoolId',
      'MonitorBootstrapBucketArn',
      'MonitorBootstrapBucketName',
      'RecordingBucketArn',
      'RecordingBucketName',
      'SessionTableArn',
      'SessionTableName',
      'SessionTableStreamArn',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
