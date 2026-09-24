# Infrastructure boundary

Status: no infrastructure provisioned. The IaC tool, AWS Region, and domain remain open.
Use the [architecture](../docs/architecture.md) and
[decision register](../docs/decisions/README.md).

First task: deploy the smallest spike that proves the environment path. Push the
reference images to ECR, run a task by digest in private subnets with only VPC endpoints,
reach its terminal through the ALB and one gateway copy over WebSockets, and stop it from
a Scheduler job. Record time to a ready terminal, isolation test results, permissions,
and teardown commands in the PR.

Before a pilot, add Route 53, Cognito, the REST API with streaming, separate environment
configuration, least-privilege roles, budgets and alarms including Fargate vCPU use,
the reconciliation sweep, backup and restore validation, and rollback. Do not add a NAT
gateway, Redis, or unrelated AWS services without a recorded need.
