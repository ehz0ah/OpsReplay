# API application boundary

Status: session-start admission is implemented and tested locally. No public route is
connected and no AWS deployment has run. Follow [architecture](../../docs/architecture.md),
[API](../../docs/api.md), [data model](../../docs/data-model.md),
[Challenge environments](../../docs/challenges.md), and
[LLM integration](../../docs/llm.md).

Own the Lambda handlers: identity, plans, catalogue, Learn, session start and end,
terminal tickets, hints, timeline, debrief, playback, Code Review matching, and
assistant turns. Also own the lifecycle handlers for readiness, time limits, the
heartbeat sweep, reconciliation, and the finaliser. Keep the LLM handler separately
deployed while sharing modules.

## Current action: start a session

The [start handler](src/start-session/index.ts) is one Lambda for `POST /v1/sessions`.
It validates the API Gateway Cognito identity and request, reads an existing receipt
first, checks access, and atomically saves the receipt, active-session lock, and session.
It calls DynamoDB, never another Lambda. Shared code is bundled into the function.
After a receipt miss, it reads the active lock alongside the content, plan, and progress
snapshot. Published content must include a Pro limit greater than its Free limit.

The transaction checks that content, plan, and progress have not changed since they were
read. Concurrent copies of a request return one session. Competing requests cannot create
two active sessions. Lost write responses are recovered through receipts. Responses use
explicit nested field lists and the public JSON Schema. Logs contain only an operation,
request ID, result code, and duration.

The deployed handler has no development identity or local endpoint switch. A future
API Gateway route must require a Cognito authorizer and restrict Lambda invocation to
that route. Tests construct the authorizer context directly.

This increment does not launch tasks, create schedules, provide status/end routes,
release locks, or mark sessions ready. The Lambda has zero reserved concurrency and no
trigger. Do not enable it until launch, deadlines, and cleanup are integrated. Do not
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

API tests use the real handler and AWS SDK against a digest-pinned DynamoDB Local
container. It binds to loopback, uses dummy credentials, and is removed after testing.
Docker may pull the image on the first run. Tests also inject lost responses, failed
reads, and changed admission snapshots. These checks do not prove AWS IAM, Cognito
verification, cloud networking, or Fargate behaviour.

The build bundles the SDK and validators from the lockfile into `dist/start-session/`.
CDK output goes to `cdk.out/`. Neither directory belongs in Git.

## Bounds

- Request body: 8 KiB decoded, bounded before parsing.
- One active session per learner, enforced by a transaction.
- Three attempts for known transaction contention, with bounded delays.
- Two SDK attempts, a 500 ms connection timeout, and a 2 second request timeout that aborts.
- One second of the Lambda duration is reserved for a structured response and final log.
  The remaining-time signal cancels DynamoDB work and contention delays.
- Lambda: 10 second timeout and 256 MiB memory, not yet performance-tuned.
- Reuse only clients and validators, never learner state, across invocations.

Next: ECS launch and cleanup. Local Docker remains a test tool, not a second platform runtime.
