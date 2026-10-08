# Infrastructure boundary

Status: CDK TypeScript definitions exist for session start, provisioning-expiry cleanup,
recording-work publication, and the private gateway recording worker. Nothing is
provisioned. The Region, domain, school-account deployment permissions, and network
inputs remain unverified.
Use the [architecture](../docs/architecture.md) and
[decision register](../docs/decisions/README.md).

## Current definitions

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

## First AWS checkpoint

Build a small integrated flow before deploying: start, terminal access, investigation
and repair, recovery, end, and verified cleanup. Use the NUS school account with a
separate SSO profile. Never use the default or personal AWS profile. Confirm permissions,
allowed Region, budget, and expiry before bootstrap or deployment.

Add repeatable deploy and cleanup commands with that checkpoint. Push pinned images to
ECR, run private tasks with only the required VPC endpoints, and reach them through the
gateway. Save test results, stop runtime tasks, destroy the exact test stack, and verify
leftovers. Cleanup must handle failed tests and have an independent expiry path for a
crashed runner. Verify the recording tags and lifecycle rules on managed S3. Verify that
an initial tagged upload succeeds and a standalone retag attempt fails. Verify that
deletion of one terminal test session removes its S3 prefix before its DynamoDB partition
and matching start receipt. Record readiness time, isolation results, cost, and retained
resources.
No full-stack AWS run is required for each small PR. This change provides the inactive
deployment definition only. It does not claim AWS validation.

Before a pilot, add Route 53, Cognito, the REST API with streaming, separate environment
configuration, least-privilege roles, budgets and alarms including Fargate vCPU use,
the reconciliation sweep, backup and restore validation, and rollback. Do not add a NAT
gateway, Redis, or unrelated AWS services without a recorded need.
