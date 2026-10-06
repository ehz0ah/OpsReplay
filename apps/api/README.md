# API application boundary

Status: session-start admission, ECS launch orchestration, and provisioning-expiry
cleanup are implemented and tested locally. No public route is connected and no AWS
deployment has run. Follow [architecture](../../docs/architecture.md),
[API](../../docs/api.md), [data model](../../docs/data-model.md),
[Challenge environments](../../docs/challenges.md), and
[LLM integration](../../docs/llm.md).

Own the Lambda handlers: identity, plans, catalogue, Learn, session start and end,
terminal tickets, hints, timeline, debrief, playback, Code Review matching, and
assistant turns. Also own the lifecycle handlers for readiness, time limits, the
heartbeat sweep, reconciliation, and the finaliser. Keep the LLM handler separately
deployed while sharing modules.

## Current actions

The [start handler](src/start-session/index.ts) is one Lambda for `POST /v1/sessions`.
It validates the API Gateway Cognito identity and request, reads an existing receipt
first, checks access, and atomically saves the receipt, active-session lock, and session.
It calls DynamoDB, never another Lambda. Shared code is bundled into the function.
After a receipt miss, it reads the active lock alongside the content, plan, and progress
snapshot. Published content needs a Pro limit greater than its Free limit and an
`opsreplay-` task-definition family.

The transaction checks that content, plan, and progress have not changed since they were
read. It stores immutable ECS arguments and a random monitor secret before any external
effect. The handler creates the recovery callback, then the timeout callback. It writes
the secret to a private, encrypted S3 environment file and passes only its reference to
ECS `RunTask`. It then saves the returned task ARN. Repeating the request uses the saved arguments
and ECS client token. Concurrent copies cannot create two tasks.

The [expiry handler](src/expire-provisioning/index.ts) is a separate Scheduler target.
At the saved deadline it marks a session `error`, discovers and stops active tasks, and
releases the learner lock only after cleanup is confirmed. Expected waiting returns
`pending` until the separate recovery callback at eight minutes. After that, Lambda
retries function failures twice. Alarms cover dropped events and failed delivery. The two Lambda actions share modules and do not invoke
each other.

The deployed handler has no development identity or local endpoint switch. A future
API Gateway route must require a Cognito authorizer and restrict Lambda invocation to
that route. Tests construct the authorizer context directly.

This increment does not provide status/end routes, readiness, monitoring, terminal
access, or recording. Both Lambdas have zero reserved concurrency, and the start Lambda
has no trigger. Do not enable them until the remaining integrated flow is ready. Do not
seed the draft repository Challenge as published content.

## Local checks

Use Node 22, npm 10+, and Docker. No AWS profile or credentials are required.

```sh
npm ci
npm run check
npm run typecheck
npm run api:test
npm run infra:test
npm run infra:synth
```

API tests use the real handlers and AWS SDK against a digest-pinned DynamoDB Local
container. It binds to loopback, uses dummy credentials, and is removed after testing.
Docker may pull the image on the first run. Fake ECS and Scheduler ports test lost
responses, duplicate calls, deadline races, and cleanup. These checks do not prove AWS
IAM, Cognito verification, Scheduler delivery, cloud networking, or Fargate behaviour.

The build creates separate `dist/start-session/` and `dist/expire-provisioning/`
bundles from the lockfile. CDK output goes to `cdk.out/`. These directories do not
belong in Git.

## Bounds

- Request body: 8 KiB decoded, bounded before parsing.
- One active session per learner, enforced by a transaction.
- Three attempts for known transaction contention, with bounded delays.
- Two SDK attempts and a 500 ms connection timeout. DynamoDB requests stop after two
  seconds. ECS, Scheduler, and S3 requests stop after three seconds.
- One second of the Lambda duration is reserved for a structured response and final log.
  The remaining-time signal cancels AWS requests and contention delays.
- Lambdas: 20 second timeout and 256 MiB memory, not yet performance-tuned.
- Reuse only clients and validators, never learner state, across invocations.

Next: monitor health and gateway recording before readiness. Local Docker remains a test
tool, not a second platform runtime.
