# Infrastructure boundary

Status: CDK TypeScript definitions exist for session start and provisioning-expiry
cleanup. Nothing is provisioned. The Region, domain, and school-account deployment
permissions remain unverified.
Use the [architecture](../docs/architecture.md) and
[decision register](../docs/decisions/README.md).

## Current definitions

[SessionStartStack](session-start-stack.ts) defines an on-demand DynamoDB table, separate
start and provisioning-expiry Lambdas, an EventBridge Scheduler group, a private S3
secret-file bucket, dropped-event alarms, and narrow roles.
The start action can read and update session records, create its two named callbacks,
write the session secret file, and run one tagged task from an `opsreplay-*` task
definition. The expiry action can find,
describe, and stop tasks in the configured cluster and release the matching active lock.
The Scheduler role can invoke the expiry action. Both functions stay outside the VPC.

No API, function URL, event source, ECS cluster, VPC, or task definition is created.
Reserved concurrency is zero for both functions. Deployment parameters identify the
existing cluster, private subnets, security groups, and environment execution role.

`npm run infra:synth` uses the CDK library locally. It does not read AWS profiles,
make AWS API calls, bootstrap, or deploy. `npm run infra:test` checks the generated
resources, permissions, and disabled entry point.

The table and secret-file bucket use `Retain` by default. Stack deletion would keep
their data and storage charges. Secret files use S3-managed encryption, HTTPS, public-access blocking, and
one-day lifecycle expiration. Expiration is asynchronous. This is a bootstrap-file
retention rule, not a session deadline. The bucket policy grants reads only to the
configured task execution role. Start has `PutObject` only, and expiry has no S3 access.
The task execution role must be in the deployment account. Private tasks need the S3
endpoint route and an endpoint policy permitting this bucket, alongside their image
pull dependencies. The monitor must not print its environment or share it with the
learner container. The pinned definition must not override `OPSREPLAY_MONITOR_SECRET`.
Validate these conditions in the integrated Fargate test before enabling either action.

Lambda async failures have two retries and a 15-minute event age. CloudWatch alarms
watch `AsyncEventsDropped` and Scheduler `InvocationDroppedCount`. Notification routing
and operator ownership must be configured at the deployment checkpoint. After an alarm,
inspect expiry logs for the session ID and rerun cleanup after correcting the cause.
Keep the lock until task stop is confirmed. Never clear locks manually to hide an error.

The later disposable test stack must choose explicit export and deletion rules.
Do not assume stack deletion removes retained data, runtime tasks, or bootstrap storage.

## First AWS checkpoint

Build a small integrated flow before deploying: start, terminal access, investigation
and repair, recovery, end, and verified cleanup. Use the NUS school account with a
separate SSO profile. Never use the default or personal AWS profile. Confirm permissions,
allowed Region, budget, and expiry before bootstrap or deployment.

Add repeatable deploy and cleanup commands with that checkpoint. Push pinned images to
ECR, run private tasks with only the required VPC endpoints, and reach them through the
gateway. Save test results, stop runtime tasks, destroy the exact test stack, and verify
leftovers. Cleanup must handle failed tests and have an independent expiry path for a
crashed runner. Record readiness time, isolation results, cost, and retained resources.
No full-stack AWS run is required for each small PR.

Before a pilot, add Route 53, Cognito, the REST API with streaming, separate environment
configuration, least-privilege roles, budgets and alarms including Fargate vCPU use,
the reconciliation sweep, backup and restore validation, and rollback. Do not add a NAT
gateway, Redis, or unrelated AWS services without a recorded need.
