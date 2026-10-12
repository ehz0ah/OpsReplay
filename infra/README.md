# Infrastructure boundary

Status: CDK TypeScript definitions exist for a disposable AWS checkpoint foundation,
session start, provisioning-expiry cleanup, recording-work publication, terminal-ticket
issuance, session-status reads, owner end, session reconciliation, bounded sweep,
and the combined Gateway path behind a public ALB. One complete-runtime switch now gates
the actions and triggers required to finish existing sessions. A separate admission
switch gates only new session starts. Both default to inactive. See the
[lifecycle decision](../docs/decisions/session-lifecycle.md). The first disposable
checkpoint verified GitHub OIDC image
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

- one VPC with two public ingress subnets and two isolated workload subnets across two
  Availability Zones;
- one internet gateway for the public ALB subnets and no NAT gateway;
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

The ALB requires public subnets in two Availability Zones. Gateway and environment tasks
remain in isolated subnets. Interface endpoints exist in both workload subnets and incur
hourly charges while the stack exists. The stack outputs the network, cluster, role,
prefix-list, and repository values needed by later deployment steps. It does not define
a task, service, Lambda activation, or load balancer.

The environment role can pull only the monitor and first-Challenge images and write the
environment log group. It is an ECS execution role, not a task role, so the containers
do not receive AWS credentials. The application stack grants this role access to the
per-session bootstrap file through the bucket policy.

[SessionStartStack](session-start-stack.ts) defines an on-demand DynamoDB table with the
keys-only `unfinished-work` index and ticket TTL, separate start, provisioning-expiry,
recording-work, session-status, and terminal-ticket Lambdas, an EventBridge Scheduler group, a private S3
secret-file bucket, a separate private recording bucket, failure alarms, and narrow
roles.
The start action can read and update session records, create its two named callbacks,
write the session secret file, and run one tagged task from an `opsreplay-*` task
definition. The expiry action can find,
describe, and stop tasks in the configured cluster and release the matching active lock.
The Scheduler role can invoke the expiry action. Both functions stay outside the VPC.

The stack also defines an ECS task-state rule, encrypted dead-letter queue, combined
Gateway task and service, TLS ALB listener, WAF rate limit, target health check, and the
authenticated session-status and terminal-ticket API routes. It does not create the ECS
cluster, VPC, VPC endpoints, ECR repositories, certificate, DNS record, or web app. It
uses an existing Cognito user pool and client by default. The explicit managed mode
instead creates a retained checkpoint user pool, public client, and AWS-managed login
domain.

`EnableGatewayPath` defaults to `false`. In this state all runtime actions have zero
reserved concurrency, all runtime event paths are disabled, and the ALB, WAF, shared
session API, Gateway task, and Gateway service are omitted. Enabling it activates the
recording publisher, filtered lifecycle stream, minute sweep, RUNNING and STOPPED task
events, reconciliation, owner end, result reads, status, terminal tickets, and one
Gateway service with the configured desired count. ExpireProvisioning stays disabled
because current schedules target ReconcileSession.

`EnableSessionAdmission` also defaults to `false` and cannot be true unless
`EnableGatewayPath` is true. It changes only StartSession reserved concurrency. Closing
admission therefore keeps every existing-session path available while attempts drain.
See the [activation decision](../docs/decisions/checkpoint-activation.md) and
[AWS checkpoint runbook](../docs/runbooks/aws-checkpoint-activation.md).

The public API bundles validate the exact browser origin and Cognito app-client ID when
they initialise. The default disabled configuration leaves those values empty, so an
accidental invocation fails closed during initialisation. This is expected until the
Gateway path is configured and enabled.

Activation requires a pinned Gateway image digest, ACM certificate ARN, exact allowed
web origins, WSS Gateway URL, and a complete external or checkpoint-managed Cognito
configuration. Deployment inputs also identify the public and private subnets, cluster,
VPC, environment security groups, execution role, private endpoint destinations, VPC DNS
resolver, service count, and per-process recording capacity. The image must exist in the
same account and Region under `opsreplay-gateway`, addressed by digest.

The ALB can reach only Gateway TCP 8080. Gateway can reach environment TCP 7681 for the
terminal and TCP 9443 for Monitor control. Gateway has no public address or internet
route. Environment tasks have no task role. WAF limits `/v1/terminal` upgrades to 300
per source IP per minute. The ticket method uses Cognito, a burst limit of 16, a rate of
8 requests per second, and fixed pre-Lambda public error responses. These three limits
are stack parameters. Their defaults target the first 50-learner checkpoint and must be
validated under shared-IP and mass-reconnect load. A browser that receives `429` must
retry with capped exponential backoff and full jitter.

The session-status method shares the Cognito REST API and has independent burst and
rate parameters, defaulting to 16 and 8 requests per second. Its Lambda has only
`dynamodb:GetItem` for `SESSION#*` and scoped log-write permissions. It performs no
state update. API response caching and data tracing are disabled for both methods.
These are bounded checkpoint defaults, not measured polling capacity.

Reconcile and sweep reuse deterministic debrief/finalisation code after confirmed
cleanup. Their roles add private manifest `GetItem`, session `Query`, bounded reads for
the required metric, terminal, and playback object prefixes, and retention-tagged
playback writes. They cannot list or delete recording objects, change an existing
retention tag, or invoke another Lambda. They run only when the complete runtime switch
is enabled.

The application stack does not create an environment task definition. The separate
[`ReferenceEnvironmentStack`](reference-environment-stack.ts), synthesised as
`OpsReplayReferenceEnvironment`, defines only a candidate
`opsreplay-wrong-upstream-port` task revision. It creates no service, task launch,
publication record, IAM role, or network resources and changes no activation flags.
See the [reference task decision](../docs/decisions/reference-environment-task.md).

Its required parameters have no defaults:

| Parameter                     | Input                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `EnvironmentExecutionRoleArn` | Existing foundation execution role, with application bootstrap-bucket access       |
| `EnvironmentLogGroupName`     | Existing foundation environment log group                                          |
| `ChallengeImageDigest`        | Tested SHA-256 digest in `opsreplay/challenge-wrong-upstream-port`                 |
| `ReferenceMonitorImageDigest` | Tested **reference target** digest in `opsreplay/monitor`, not the generic runtime |

Images must be in the deployment account and Region. `ReferenceTaskDefinitionArn`
is a candidate revision, not evidence of publication or permission to admit sessions.
The task has 1024 CPU units and 2048 MiB memory. Challenge/Monitor receive 768/256
relative CPU shares and 1536/512 MiB hard memory limits. CPU shares are not independent
hard CPU quotas. Both containers are essential, use an init process, and have a
30-second stop timeout. There is no task role, shared PID namespace, or service
health check that would restart a learner's intentionally broken services.

The definition applies [the watched-volume helper](environment-watched-volume.ts):
one ephemeral per-task volume, Challenge writable, Monitor read-only, Challenge-only
`OPSREPLAY_WATCHED_FILES=1`, and no secrets in that volume. Monitor runs non-root
with no capabilities and a read-only root. Its private manifest is baked into the
reference image; bounded recording state stays in process memory. The existing
start action supplies only Monitor's encrypted S3 environment-file override.
`START` ordering does not establish readiness; Monitor's existing initial-state checks
and the recording lifecycle still gate learner access.

Only Monitor's fixed-code process logs use bounded, non-blocking CloudWatch delivery.
Challenge stdout is not a recording path; terminal evidence still comes from the PTY.
Private subnets, security groups, public-IP disabling, ECS Exec disabling, and Fargate
platform `1.4.0` remain launch/application configuration, not task-definition fields.
Local synthesis and Docker tests do not prove Fargate isolation, IAM/bootstrap
delivery, startup timing, or resource enforcement. These need the approved AWS checkpoint.

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

That existing workflow still publishes the **generic** Monitor target, which lacks
`/app/challenge.json`. It cannot supply `ReferenceMonitorImageDigest`. Publishing the
tested reference target and binding its digest and task revision to an immutable
content version belong to the separate publication PR. The authored Challenge stays
draft with null image digests in this increment.

The table and secret-file bucket use `Retain` by default. Stack deletion would keep
their data and storage charges. DynamoDB TTL removes expired terminal-ticket items by
their numeric `ExpiresAt` value. TTL deletion is asynchronous, so Gateway admission still
checks the exact ISO expiry before consuming a ticket. Secret files use S3-managed
encryption, HTTPS, public-access blocking, and
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
role can query only the work index, consume tickets and update `SESSION#*` table items,
and write only `sessions/*` objects in the recording bucket. Its execution role can pull
only the `opsreplay-gateway` ECR image and write its log group. The gateway group accepts
TCP 8080 only from the ALB group. HTTPS egress is restricted to the supplied S3 and
DynamoDB gateway-endpoint prefix lists and interface-endpoint security group. DNS egress
is restricted to the supplied VPC resolver address. The stack adds TCP 443 ingress from
the gateway group to the endpoint group. That group must be attached to the ECR API, ECR
Docker, and CloudWatch Logs interface endpoints. The workload subnets must not have an
internet or NAT route.

The later disposable test stack must choose explicit export and deletion rules. Stack
deletion does not remove the retained buckets or table. Their object lifecycle rules
continue to apply while the buckets exist.

## Checkpoint deployment commands

Use the [activation runbook](../docs/runbooks/aws-checkpoint-activation.md) for the
current runtime-only, admission, drain, and shutdown sequence. The commands below retain
the foundation history and do not by themselves authorise application activation.

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

Before a pilot, add Route 53, choose and validate the managed or external Cognito path,
connect the browser to the exact-origin REST API, add any required streaming route, add separate environment
configuration, budgets and alarms including Fargate vCPU use, the reconciliation sweep,
backup and restore validation, and rollback. Do not add a NAT gateway, Redis, or
unrelated AWS services without a recorded need.
