# Infrastructure boundary

Status: no infrastructure provisioned. The IaC tool and AWS region remain open.
Use the [architecture](../docs/architecture.md) and
[decision register](../docs/decisions/README.md).

First task: deploy the smallest integration probe that authenticates a request,
performs a conditional DynamoDB write, reads private content, and streams a
bounded response through Regional API Gateway and Lambda. Record runtime, region,
permissions, latency, and teardown commands in the implementation PR.

Before a pilot, add separate environment configuration, least-privilege roles,
private buckets, budgets, alerts, backup/restore validation, and rollback. Do not
add Redis, WebSockets, containers per learner, or unrelated AWS services.
