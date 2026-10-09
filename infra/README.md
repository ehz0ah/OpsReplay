# Infrastructure boundary

Status: CDK TypeScript definitions exist for a disposable AWS checkpoint foundation,
session start, provisioning-expiry cleanup, recording-work publication, and the private
gateway recording worker. The first disposable checkpoint verified GitHub OIDC image
publication and the private gateway runtime in AWS. Its foundation, service, and image
repositories were then removed. No OpsReplay runtime or image is currently deployed.
The account-level GitHub OIDC provider and standard CDK bootstrap stack remain. The
tested school-account permissions apply only to this checkpoint. The checkpoint commands
target the `opsreplay` profile in `ap-southeast-1`; this does not select the permanent
deployment Region.
Use the [architecture](../docs/architecture.md) and
[decision register](../docs/decisions/README.md).

## Current definitions

`GitHubOidcProviderStack` defines one optional account prerequisite. Deploy it only when
the account does not already contain the GitHub Actions provider. Keeping this provider
outside the disposable foundation gives it one stable owner across foundation updates.

`CheckpointFoundationStack` defines the minimum base for the first temporary AWS run:

- one VPC with one isolated workload subnet and no internet gateway or NAT gateway;
- ECR API, ECR Docker, and CloudWatch Logs interface endpoints;
- S3 and DynamoDB gateway endpoints;
- separate environment and interface-endpoint security groups;
- one ECS cluster;
- immutable, scan-on-push repositories for the gateway, monitor, and first Challenge,
  with cleanup limited to untagged images;
- an image publisher role that trusts only the `aws-checkpoint` GitHub environment,
  references the verified account-level GitHub OIDC provider, and is restricted to those
  three repositories;
- one environment execution role and one seven-day environment log group.

One Availability Zone reduces endpoint cost for the temporary functional checkpoint.
It is not a high-availability design. Interface endpoints incur hourly charges while
the stack exists. The stack outputs the network, cluster, role, prefix-list, and
repository values needed by later deployment steps. It does not define a task, service,
Lambda activation, or public entry point.

The environment role can pull only the monitor and first-Challenge images and write the
environment log group. It is an ECS execution role, not a task role, so the containers
do not receive AWS credentials. The application stack grants this role access to the
per-session bootstrap file through the bucket policy.

[SessionStartStack](session-start-stack.ts) defines an on-demand DynamoDB table with the
keys-only `unfinished-work` index, separate start, provisioning-expiry, and
recording-work Lambdas, an EventBridge Scheduler group, a private S3 secret-file bucket,
a separate private recording bucket, failure alarms, and narrow roles.
The start action can read and update session records, create its two named callbacks,
write the session secret file, and run one tagged task from an `opsreplay-*` task
definition. The expiry action can find,
describe, and stop tasks in the configured cluster and release the matching active lock.
The Scheduler role can invoke the expiry action. Both functions stay outside the VPC.

The stack also defines an ECS task-state rule, an encrypted dead-letter queue, a
recording-worker task definition, and a private outbound-only Fargate service. It does
not create an API, function URL, ECS cluster, VPC, VPC endpoint, ECR repository, load
balancer, or public route.

`EnableRecordingPath` defaults to `false`. In this state the publisher has zero reserved
concurrency, the task-state rule is disabled, and the gateway task definition and service
are omitted.
The start and expiry functions remain disabled independently. Enabling the recording
path sets the publisher concurrency to four, enables its rule, and applies the configured
gateway desired count. A valid gateway image digest is required only in this state. This
switch does not make session start public.

Deployment inputs identify the existing cluster, private subnets, VPC, dedicated
environment-monitor security group, environment security-group list, environment
execution role, private endpoint destinations, VPC DNS resolver, gateway image digest,
service count, and per-process recording capacity. The image must exist in the same
account and Region under `opsreplay-gateway`, addressed by digest. The environment list
must include the monitor group. The stack preserves that list for environment tasks and
adds ingress from the separate gateway group on TCP 9443. It does not give the
environment a task role.

`npm run infra:synth` uses the CDK library locally. It does not read AWS profiles,
make AWS API calls, bootstrap, or deploy. `npm run infra:test` checks the generated
resources, permissions, networking, and disabled activation state. The gateway runtime
image is built and tested separately with `npm run gateway:runtime:image:build` and
`npm run gateway:runtime:image:test`.

The `Publish checkpoint images` workflow is manual and accepts only `main`. It tests the
Challenge, Monitor, and gateway images before requesting temporary AWS credentials. It
uses the protected `aws-checkpoint` environment and its
`AWS_CHECKPOINT_IMAGE_PUBLISHER_ROLE_ARN` variable. The publisher reads each image
configuration digest from the tested Docker archive, publishes an immutable
`git-<commit-sha>-<image-config-digest>` tag, and uploads a seven-day JSON artifact with
all three registry digests. The content-specific suffix avoids collisions when a mutable
package source produces different bytes during a later build of the same commit.
Repeated runs reuse only tags that match the tested archive. The workflow does not
package Lambda code, deploy a stack, or start a task.

The table and secret-file bucket use `Retain` by default. Stack deletion would keep
their data and storage charges. Secret files use S3-managed encryption, HTTPS, public-access blocking, and
one-day lifecycle expiration. Expiration is asynchronous. This is a bootstrap-file
retention rule, not a session deadline. The bucket policy grants reads only to the
configured task execution role. Start has `PutObject` and a bounded `GetObject` recovery
read, and expiry has no S3 access.
The environment task execution role must be in the deployment account. Private tasks
need the S3 endpoint route and an endpoint policy permitting the bootstrap bucket,
alongside their image-pull dependencies. The monitor must not print its environment or share it with the
learner container. The pinned definition must not override `OPSREPLAY_MONITOR_SECRET`.
Validate these conditions in the integrated Fargate test before enabling either action.

The expiry callback has two retries and a 15-minute event age. Recording-work delivery
and asynchronous invocation have two retries, a two-minute event age, and an encrypted
dead-letter queue. CloudWatch alarms watch dropped events, visible dead letters, and
Scheduler delivery. Notification routing and operator ownership must be configured at
the deployment checkpoint. After an alarm, inspect the action logs and failure queue.
Keep the learner lock until task stop is confirmed. Never clear locks manually to hide
an error.

The recording bucket is retained when the stack is deleted, but its tagged objects have
explicit lifecycle expiry. Live pages are provisional and expire after seven days.
Sealed recordings expire after 30 days. These rules bound unreferenced uploads while
keeping active recordings safe under the four-hour session limit. Recording objects are
immutable through content-addressed keys and conditional writes. S3 bucket versioning
and Intelligent-Tiering are not enabled. The gateway role can tag a new upload with one
of the two retention classes. An explicit deny prevents it from changing the retention
tag on an existing object. See the
[recording retention decision](../docs/decisions/recording-retention.md).

The gateway task has a separate application role and execution role. Its application
role can query only the work index, read and update `SESSION#*` table items, and write
only `sessions/*` objects in the recording bucket. Its execution role can pull only the
`opsreplay-gateway` ECR image and write its log group. The gateway group has no inbound
rules. HTTPS egress is restricted to the supplied S3 and DynamoDB gateway-endpoint
prefix lists and interface-endpoint security group. DNS egress is restricted to the
supplied VPC resolver address. The stack adds TCP 443 ingress from the gateway group to
the endpoint group. That group must be attached to the ECR API, ECR Docker, and
CloudWatch Logs interface endpoints. The selected subnets must not have an internet or
NAT route.

The later disposable test stack must choose explicit export and deletion rules. Stack
deletion does not remove the retained buckets or table. Their object lifecycle rules
continue to apply while the buckets exist.

## Checkpoint deployment commands

Do not run these commands until the change is reviewed and an AWS test window is
approved. Prefix every account command so it cannot use the default profile.

```sh
npm run infra:cdk -- bootstrap --show-template --profile opsreplay --region ap-southeast-1
```

Review that template before the one-time bootstrap. Bootstrap creates the `CDKToolkit`
stack, including the S3 bucket that stages Lambda ZIP files. It does not deploy the
OpsReplay application.

```sh
npm run infra:cdk -- bootstrap --profile opsreplay --region ap-southeast-1
```

Before foundation deployment, check whether the account already has the GitHub Actions
OIDC provider. Authenticate the `opsreplay` SSO profile first if needed. Inspect each
returned provider and use only one whose URL is exactly
`token.actions.githubusercontent.com` and whose `ClientIDList` contains
`sts.amazonaws.com`.

```sh
aws sso login --profile opsreplay
aws iam list-open-id-connect-providers --profile opsreplay
aws iam get-open-id-connect-provider --profile opsreplay --open-id-connect-provider-arn '<verified-provider-arn>' --query '{Url:Url,ClientIDList:ClientIDList}'
```

If no GitHub provider exists, deploy the dedicated prerequisite stack once and record
its `GitHubOidcProviderArn` output. If one exists, do not deploy this stack. Use the
verified existing ARN instead. Do not attempt to create a second provider with the same
URL.

```sh
npm run infra:cdk -- deploy OpsReplayGitHubOidcProvider --profile opsreplay --region ap-southeast-1
```

Before foundation deployment, create a GitHub environment named `aws-checkpoint` under
Settings, Environments. Set its deployment branches and tags to `Selected branches and
tags`, then add only the `main` branch. Add a required reviewer if the team wants a
separate approval before the publish job can request AWS credentials. Do not run the
workflow with an automatically created, unprotected environment.

Confirm that the repository still uses the immutable OIDC subject prefix recorded in
the publisher trust policy:

```sh
gh api repos/ehz0ah/OpsReplay/actions/oidc/customization/sub
```

The expected response has `use_immutable_subject` set to `true` and `sub_claim_prefix`
set to `repo:ehz0ah@130889443/OpsReplay@1378586293`. Stop before deployment if either
value differs.

Before foundation deployment, obtain the current AWS-managed prefix-list IDs:

```sh
aws ec2 describe-managed-prefix-lists --profile opsreplay --region ap-southeast-1 --filters Name=prefix-list-name,Values=com.amazonaws.ap-southeast-1.s3 --query 'PrefixLists[0].PrefixListId' --output text
aws ec2 describe-managed-prefix-lists --profile opsreplay --region ap-southeast-1 --filters Name=prefix-list-name,Values=com.amazonaws.ap-southeast-1.dynamodb --query 'PrefixLists[0].PrefixListId' --output text
```

Pass the reviewed values to `diff` and `deploy`. Do not copy the placeholders below.

```sh
npm run infra:cdk -- diff OpsReplayCheckpointFoundation --profile opsreplay --region ap-southeast-1 --parameters 'GitHubOidcProviderArn=<verified-provider-arn>' --parameters S3PrefixListId=pl-s3 --parameters DynamoDbPrefixListId=pl-dynamodb
npm run infra:cdk -- deploy OpsReplayCheckpointFoundation --profile opsreplay --region ap-southeast-1 --parameters 'GitHubOidcProviderArn=<verified-provider-arn>' --parameters S3PrefixListId=pl-s3 --parameters DynamoDbPrefixListId=pl-dynamodb
```

After foundation deployment, copy the `GitHubImagePublisherRoleArn` stack output into
the `aws-checkpoint` environment variable, then run the workflow from `main`.

```sh
gh variable set AWS_CHECKPOINT_IMAGE_PUBLISHER_ROLE_ARN --env aws-checkpoint --body '<verified-role-arn>'
gh workflow run publish-checkpoint-images.yml --ref main
```

The workflow summary and `checkpoint-image-digests-<commit-sha>` artifact contain the
digest-pinned image URIs for the later runtime deployment. Do not copy an image digest
into a published content version until that runtime has passed its AWS checkpoint.

After deployment, inspect the stack outputs. Confirm that `VpcDnsResolverIpv4` is
`10.42.0.2` before passing it to the application stack. Keep an immutable tag on each
image digest used by a task definition. The lifecycle rule deletes only older untagged
images.

Destroy the exact foundation stack after the approved test. Confirm that the ECR
repositories, publisher role, endpoints, cluster, log group, subnet, and VPC are absent
afterward. Remove the `aws-checkpoint` environment variable after teardown. If this
checkpoint created the dedicated provider stack, destroy it only after the foundation
and after confirming that no other role uses the provider. Never destroy a provider that
existed before this checkpoint.

```sh
npm run infra:cdk -- destroy OpsReplayCheckpointFoundation --profile opsreplay --region ap-southeast-1
npm run infra:cdk -- destroy OpsReplayGitHubOidcProvider --profile opsreplay --region ap-southeast-1
```

## First AWS checkpoint

The first checkpoint completed on 10 October 2026. GitHub Actions run `37965328481`
built, tested, and published all three images through OIDC. The artifact digests matched
the ECR digests. A private gateway Fargate service then ran from the exact published
gateway digest without a public IP. The disposable runtime and foundation were removed,
including retained buckets, the retained table, image repositories, and the temporary
GitHub environment variable. The `CDKToolkit` and account-level
`OpsReplayGitHubOidcProvider` support stacks remain. This test did not run the complete
Challenge session or recording path.

Build a small integrated flow before deploying: start, terminal access, investigation
and repair, recovery, end, and verified cleanup. Use the NUS school account with a
separate SSO profile. Never use the default or personal AWS profile. Confirm permissions,
allowed Region, budget, and expiry before bootstrap or deployment.

The foundation provides reviewed deploy and cleanup commands but is not the complete
test runner. The next increments publish pinned images and compose the runtime resources.
Run private tasks with only the required VPC endpoints and reach them through the
gateway. Save test results, stop runtime tasks, destroy the exact test stacks, and verify
leftovers. Runtime cleanup must handle failed tests and have an independent expiry path
for a crashed runner. Verify the recording tags and lifecycle rules on managed S3. Verify that
an initial tagged upload succeeds and a standalone retag attempt fails. Verify that
deletion of one terminal test session removes its S3 prefix before its DynamoDB partition
and matching start receipt. Record readiness time, isolation results, cost, and retained
resources.
No full-stack AWS run is required for each small PR. Local checks do not prove later AWS
changes. Repeat a bounded checkpoint when a change affects a managed-service contract or
runtime behavior that local tests cannot verify.

Before a pilot, add Route 53, Cognito, the REST API with streaming, separate environment
configuration, least-privilege roles, budgets and alarms including Fargate vCPU use,
the reconciliation sweep, backup and restore validation, and rollback. Do not add a NAT
gateway, Redis, or unrelated AWS services without a recorded need.
