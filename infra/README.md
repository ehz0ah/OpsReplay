# Infrastructure boundary

Status: CDK TypeScript definitions exist for session start and provisioning-expiry
cleanup. Nothing is provisioned. The Region, domain, and school-account deployment
permissions remain unverified.
Use the [architecture](../docs/architecture.md) and
[decision register](../docs/decisions/README.md).

## Current definitions

[SessionStartStack](session-start-stack.ts) defines an on-demand DynamoDB table, separate
start and provisioning-expiry Lambdas, an EventBridge Scheduler group, and narrow roles.
The start action can read and update session records, create its named expiry schedule,
and run one tagged task from an `opsreplay-*` task definition. The expiry action can find,
describe, and stop tasks in the configured cluster and release the matching active lock.
Only Scheduler can invoke the expiry action. Both functions stay outside the VPC.

No API, function URL, event source, ECS cluster, VPC, or task definition is created.
Reserved concurrency is zero for both functions. Deployment parameters identify the
existing cluster, private subnets, security groups, and environment execution role.

`npm run infra:synth` uses the CDK library locally. It does not read AWS profiles,
make AWS API calls, bootstrap, or deploy. `npm run infra:test` checks the generated
resources, permissions, and disabled entry point.

The table uses `Retain` by default. Stack deletion would keep its data and storage
charges. The later disposable test stack must choose explicit export and deletion rules.
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
