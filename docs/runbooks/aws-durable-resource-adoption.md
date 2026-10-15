# AWS durable resource adoption

Status: completed for the selected checkpoint resources on 15 October 2026, including
post-import deletion protection.

Use this procedure once, before another runtime deployment. It changes CloudFormation
ownership. Obtain approval and use the `opsreplay` profile in `ap-southeast-1`. Keep the
runtime stopped for the complete procedure.

## 1. Select and verify one resource set

Inventory the retained tables, buckets, and user pools. Match them to the checkpoint
record and inspect their live configuration. Do not select a resource from its name
alone.

Verify these table properties:

- `PK` partition key and `SK` sort key;
- pay-per-request billing;
- keys-only stream;
- `ExpiresAt` TTL;
- keys-only `unfinished-work` index on `WorkPK` and `WorkSK`.

Verify both buckets use S3-managed encryption and block all public access. Verify the
bootstrap bucket expires `sessions/` objects after one day. Verify the recording bucket
expires `provisional` objects after 7 days and `sealed` objects after 30 days. Verify the
selected user pool uses email usernames, verified email recovery, and admin-only user
creation.

Stop if any selected resource belongs to another CloudFormation stack, differs from the
required configuration, or cannot be identified with confidence. Do not modify or delete
any retained resource to make the import pass.

## 2. Review the import mapping

Use the exact physical names as CDK context. These values must be identical for import,
diff, and every later durable-stack operation.

```sh
npm run infra:cdk -- import OpsReplayDurableResources \
  --profile opsreplay --region ap-southeast-1 \
  -c durableSessionTableName=<table-name> \
  -c durableMonitorBootstrapBucketName=<bootstrap-bucket-name> \
  -c durableRecordingBucketName=<recording-bucket-name> \
  -c durableCognitoUserPoolName=<user-pool-name> \
  --record-resource-mapping <untracked-mapping-file>
```

This command records a mapping and makes no AWS change. Enter the selected user-pool ID
when requested. Inspect the file. It must map exactly one DynamoDB table, two S3 buckets,
and one Cognito user pool. Remove or reject any other entry.

## 3. Import, then apply bucket policies

Run the import with the reviewed mapping. Do not use `--force`.

```sh
npm run infra:cdk -- import OpsReplayDurableResources \
  --profile opsreplay --region ap-southeast-1 \
  -c durableSessionTableName=<table-name> \
  -c durableMonitorBootstrapBucketName=<bootstrap-bucket-name> \
  -c durableRecordingBucketName=<recording-bucket-name> \
  -c durableCognitoUserPoolName=<user-pool-name> \
  --resource-mapping <untracked-mapping-file>
```

The import operation adds only supported existing resources. It can report that the two
new bucket policies were skipped. This is expected. Do not accept a replacement, update,
or deletion in the import change set.

After the import succeeds, run drift detection. Then run `cdk diff` with the same context.
The first normal update may add only the two policies that deny insecure S3 transport,
stack metadata, and outputs. Inspect that change set before deployment. Stop if it changes
or replaces a table, bucket, user pool, stream, TTL, index, lifecycle rule, or public-access
setting.

After the update, verify all four resources are `UPDATE_COMPLETE`, owned by
`OpsReplayDurableResources`, and not drifted. Save its outputs for the foundation and
runtime parameter records. Keep the untracked mapping out of Git.

## 4. Add deletion protection after adoption

Do not add service-level deletion protection to an initial import template unless the
selected resources already use it. An import operation cannot change resource properties.

For the selected resources, a separate reviewed change enabled DynamoDB and Cognito
deletion protection. Its change set updated only those two properties without
replacement. The live settings and subsequent zero-drift result were verified.

For future imports, use the same sequence. Apply protection only after the import,
policy update, and drift checks complete. Review the change set before deployment and
verify the live settings before any runtime deployment.

Evaluate DynamoDB point-in-time recovery separately. It has an ongoing storage cost and
needs an approved retention, restore-test, and budget decision. It is not required to
complete resource adoption.

## 5. Handle unselected resources separately

Importing one set does not authorize deletion of any other retained table, bucket, or
user pool. Record each unselected resource, its contents, owner, and ongoing cost. Delete
it only through a separate approved data-disposition action.
