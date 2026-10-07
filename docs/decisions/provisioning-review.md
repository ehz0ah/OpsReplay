# ADR: provisioning recovery and secret delivery

Status: implemented locally, AWS validation pending
Date: 2026-10-06
Owner: Hao Zhe

## Context

PR #7 review found that the five-minute launch-recovery window exceeded Lambda's
default function-error retries. It also found that the monitor secret was visible in
ECS container overrides. Rejected launches had inconsistent replay responses, and
content admission accepted task families that IAM would reject.

## Decision

- Create the eight-minute recovery callback first, then the three-minute timeout
  callback, before any task launch. The timeout handler returns `pending` while
  waiting for task visibility. Known tasks that are stopping use Lambda's short
  retries so their locks can be released sooner. The later recovery callback remains
  independent of those retries.
  Unexpected failures still use two Lambda retries, with a 15-minute event age.
  CloudWatch alarms cover dropped Lambda events and Scheduler deliveries.
- Store the per-session monitor secret in an encrypted, private S3 environment file.
  `RunTask` contains only its ARN. The ECS agent fetches it using the execution role.
  Tasks retain no task IAM role or internet route. Only the monitor gets the variable.
  Conditional upload preserves the saved file across retries. A 409 conditional-write
  conflict retries the same upload once, within the invocation deadline. A 409 alone
  is not proof that a file exists. S3 lifecycle expiration
  removes bootstrap objects after one day, asynchronously.
- When monitor TLS delivery is implemented, put its certificate and private key in this
  same encrypted per-session file. Store the public certificate in the private session
  record for gateway verification. Never put the private key in a `RunTask` override.
- Save confirmed launch failure kind and normalized reason codes in the same
  transaction that ends the session and releases its lock. Capacity errors replay
  as 503. Other confirmed rejections replay as 500. A new launch needs a new request
  ID. Unknown outcomes retain the same-ID retry rule.
  Fargate's documented `Capacity is unavailable at this time.` message is normalized
  to `CAPACITY`. The message itself never enters logs or saved failure metadata.
- Require the `opsreplay-` task family during admission. Keep one private transaction
  helper for lock release, one bounded AWS transport, and one SDK send-options helper.
  Return the latest session from provisioning to avoid a redundant consistent read.

## Alternatives and consequences

Scheduling only at eight minutes would delay the visible timeout and task stop. Two
fixed callbacks preserve the three-minute timeout without giving expiry permission to
create schedules. A crash between their writes still leaves the recovery callback.
A crash before the first schedule is created still needs a client retry or the planned
reconciliation sweep. This increment remains disabled.

AWS recommends Secrets Manager or SSM for secrets. However, `ContainerOverride` has no
`secrets` field. A unique secret reference per session would require another task
definition revision, which conflicts with the pinned revision. A shared secret would
increase the scope of a leak. Fetching secrets from inside the task needs a task role,
which is outside the isolation contract. S3 environment-file overrides fit the current
constraints without changing the pinned definition.

The secret remains plaintext inside the monitor process. Its environment must never
be logged or shared with the learner container. This decision removes plaintext from
ECS API metadata. It does not replace monitor isolation or authenticated TLS.

## Validation

Regression tests cover the 0, +60, and +180 second timeout-delivery sequence, the later
recovery callback, interrupted schedule setup, late tasks, lost storage replies,
concurrent rejection, secret upload failure, replay responses, and task-family rejection.
CDK assertions check disabled functions, IAM, encryption, async settings, and alarms.
The integrated AWS test must verify file injection, private S3 access, isolation,
Scheduler timing, and alarm notification routing before enablement.

The follow-up review exposed gaps in the first tests: synthetic capacity codes missed
Fargate's text response, S3 tests covered 412 but not 409, and cleanup tests called the
next check directly without requiring an event to trigger it. New tests failed on
`bb095ab` and pass with the correction. They cover the actual capacity message through
the HTTP handler, S3 conflict retries and cancellation, concurrent starts, and the
short cleanup retry while retaining the independent recovery callback.

## Sources

- [Scheduler invokes Lambda asynchronously](https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html)
- [Lambda function-error retries](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html)
- [ECS task metadata includes overrides](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_Task.html)
- [Allowed container overrides](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerOverride.html)
- [Environment-file injection and execution-role requirements](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/use-environment-file.html)
- [AWS secret-delivery guidance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html)
- [ECS failure reason codes](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/api_failures_messages.html)
- [Fargate capacity error wording](https://repost.aws/knowledge-center/ecs-fargate-runtask-capacity)
- [S3 conditional upload conflicts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)
- [Scheduler metrics](https://docs.aws.amazon.com/scheduler/latest/UserGuide/monitoring-cloudwatch.html)
