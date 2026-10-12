# API application boundary

Status: admission, launch, recording work, status, terminal tickets, owner end,
readiness, outcomes, liveness, deadline repair, and confirmed cleanup are implemented
and tested locally. Deterministic debrief and atomic once-only finalisation now run
as shared code in reconcile/sweep after confirmed cleanup. CDK defines disabled
routes and lifecycle triggers. Bounded resumable playback exports and three separate
owner debrief/timeline/playback read actions are implemented locally. New actions remain
disabled. No AWS deployment has run for this increment. Follow
[architecture](../../docs/architecture.md),
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
first, checks access, and atomically saves the receipt, active-session lock, session,
and separate indexed lifecycle item.
It calls DynamoDB, never another Lambda. Shared code is bundled into the function.
After a receipt miss, it reads the active lock alongside the content, plan, and progress
snapshot. Published content needs a Pro limit greater than its Free limit and an
`opsreplay-` task-definition family.

The transaction checks that content, plan, and progress have not changed since they were
read. It stores immutable ECS arguments and a random monitor secret before any external
effect. The handler creates the recovery callback, then the timeout callback. It creates
one per-session TLS key pair that covers the bounded recording drain. It writes the
secret, certificate, and private key to a private, encrypted S3 environment file. The
same write stores the public certificate in object tags for recovery. The start action
can read the public tags but cannot read the environment-file body. It stores only the
public certificate in DynamoDB and passes only the file reference to ECS `RunTask`. It
then saves the returned task ARN. Repeating the request uses the saved arguments,
bootstrap file, and ECS client token. Concurrent copies cannot create two tasks or
select different certificates.

The [recording-work handler](src/publish-recording-work/index.ts) is a separate action
for ECS `RUNNING` task-state events. It validates one ENI private IPv4 address, checks the
saved cluster and task identity, stores the private address, and adds one sparse
recording-work index entry in the same conditional update. It does not mark the session
ready or run the recorder. Its EventBridge rule and Lambda deployment are not part of
the handler increment. CDK now defines its Lambda, bounded retries, encrypted failure
queue, alarm, and ECS task-state rule. One activation parameter keeps the rule and
function disabled with the recording service until an approved AWS checkpoint.

The [session-status handler](src/get-session/index.ts) is a separate action for
`GET /v1/sessions/{id}`. It validates identity and request shape before one strongly
consistent session read. Missing and foreign sessions return the same `404`. Owned
records must validate against the saved session schema and access grant before the
shared nested-field projection returns `SessionView`. Plan expiry and content withdrawal
do not block a saved attempt. The action never changes state or learner activity.
It has its own bundle, log group, read-only role, 10-second timeout, concurrency limit,
and method throttling. The route shares the existing Cognito API and stays absent when
`EnableGatewayPath=false`; reserved concurrency is then zero. Its SDK uses at most two
attempts with a two-second request timeout, bounded by the invocation deadline.

The [terminal-ticket handler](src/create-terminal-ticket/index.ts) is a separate action
for `POST /v1/sessions/{id}/terminal-tickets`. It trusts only the Cognito identity from
the API Gateway authorizer and accepts no request body. It strongly reads the private
session, then uses one conditional DynamoDB transaction to confirm the same owner,
session ID, `ready` status, and private task address before it stores a ticket. The
response contains a 256-bit base64url ticket, the configured WSS Gateway URL, and a
60-second expiry. DynamoDB stores only the SHA-256 ticket hash, owner, session, ISO
expiry, and numeric `ExpiresAt` cleanup value. The raw ticket is not logged or stored.

An uncertain transaction response is reconciled with a transactional read. An exact
stored ticket is success. A hash collision causes generation of a new ticket. Known
transaction contention has bounded retries. Provisioning, terminal, ownership, and
configuration failures fail without storing a ticket. Gateway admission remains
responsible for consuming the ticket once and claiming the terminal input generation.

The CDK definition configures table TTL on `ExpiresAt` and reserves that attribute for
expiring items. The action has its own Lambda, log group, and role. The role is limited
to `dynamodb:GetItem`, `dynamodb:ConditionCheckItem`, and `dynamodb:PutItem` on
`SESSION#*`. Its single API Gateway method requires an existing Cognito user pool, has a
default rate of 8 requests per second and burst of 16. Stack parameters can tune these
limits for the checkpoint. API Gateway maps throttling, authentication, access, other
4xx, and 5xx failures to the public error shape without invoking Lambda. The function
has zero reserved concurrency and the route is absent while the Gateway path is disabled.

The [reconciliation action](src/reconcile-session/index.ts) checks saved session state
from timers, DynamoDB streams, and ECS STOPPED events. The separate
[sweep action](src/sweep-sessions/index.ts) checks at most 25 lifecycle entries each
minute and persists its pagination cursor. Both call the same in-process routine.
They do not invoke another Lambda. Provisioning and ready timers target reconciliation;
the earlier provisioning-expiry definition remains disabled for rollback compatibility.

The [owner end action](src/end-session/index.ts) validates Cognito identity and a request
ID. It saves one outcome and receipt, with a fixed recording cutoff and 30-second task drain.
A durable coverage receipt permits task stop while terminal sealing continues under its
separate 24-hour bound. Cleanup confirms STOPPED and deletes all timers. Missing Monitor
observations allow five minutes for recorder recovery, then use `recorder_unavailable`.
Only transition hints invoke stream reconciliation, not per-page or lease writes.
Ready-attempt locks remain held until the shared finaliser commits debrief, highlights,
progress, and finalisation together. Playback export completion does not delay that
transaction. Never-ready attempts have no debrief.
See the [lifecycle decision](../../docs/decisions/session-lifecycle.md) for authority,
recovery replay, heartbeat rules, failure handling, and activation limits.

The deployed handler has no development identity or local endpoint switch. A future
API Gateway route must require a Cognito authorizer and restrict Lambda invocation to
that route. Tests construct the authorizer context directly.

The terminal-ticket action has no deployed AWS route. The definition depends on an ACM
certificate, public terminal URL, exact web origin, and existing Cognito user pool at
activation. DNS, Cognito creation, and browser CORS remain separate work.
The owner end route and lifecycle actions are defined but remain disabled.
The start and expiry Lambda definitions have zero reserved concurrency, and the start
Lambda has no trigger. The recording-work action, session-status and terminal-ticket routes, and combined
Gateway service are also inactive by default. Do not enable the flow until its AWS
integration checks pass.
Do not seed the draft repository Challenge as published content.

The separate [debrief](src/get-debrief/index.ts), [timeline](src/list-timeline/index.ts),
and [playback](src/get-playback/index.ts) actions use the same saved-owner/grant checks,
with no state mutation. Debrief reads saved results. Timeline reads bounded command and
Monitor projections. Live pages use a stable session/source identity and an `(at, id)`
keyset cursor. Appends and lease changes do not invalidate it. The cursor remains at the
last event on an empty poll. A readiness/source change or the switch to a final snapshot
requires restart. Final pages retain strict snapshot binding.
Playback uses fixed export/capture snapshots and keyset reference paging, verifies selected
object length/checksum, and signs at most 25 links for at most 300 seconds. Temporary
credential expiry and recording retention can shorten that duration. Each action has its
own bundle, read-only role, timeout, and zero reserved concurrency. Routes are conditional
on the Gateway path but these functions still require explicit checkpoint activation.

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

The build creates separate `dist/start-session/`, `dist/get-session/`, `dist/create-terminal-ticket/`,
`dist/expire-provisioning/`, `dist/publish-recording-work/`, `dist/end-session/`,
`dist/reconcile-session/`, `dist/sweep-sessions/`, `dist/get-debrief/`,
`dist/list-timeline/`, and `dist/get-playback/` bundles from the lockfile.
CDK output goes to `cdk.out/`. These directories do not belong in Git.

## Bounds

- Request body: 8 KiB decoded, bounded before parsing.
- One active session per learner, enforced by a transaction.
- Three attempts for known transaction contention, with bounded delays.
- Two SDK attempts and a 500 ms connection timeout. DynamoDB requests stop after two
  seconds. ECS, Scheduler, and S3 requests stop after three seconds.
- One second of the Lambda duration is reserved for a structured response and final log.
  The remaining-time signal cancels AWS requests and contention delays.
- Lifecycle: 30-second reconciliation timeout, 60-second sweep timeout, and
  10-second end timeout. Sweep concurrency is five sessions with eight seconds each,
  at most 25 per invocation. New functions have zero reserved concurrency.
- Memory: 512 MiB for reconcile, 1,024 MiB for sweep, 256 MiB for other current
  actions. Sweep can hold five bounded evidence sets. These are checkpoint defaults,
  not performance-tuned values.
- Reuse only clients and validators, never learner state, across invocations.

Read limits: debrief 256 MiB/10 seconds; timeline and playback 512 MiB/25 seconds,
with API integration timeouts of 8 and 23 seconds. Read routes have a checkpoint burst
of four and rate of two per second. Timeline rereads bounded history per page; cloud
latency and memory use remain unmeasured. Export preparation processes at most 20 source
pages per pass in the existing reconcile/sweep functions.

Next: reviewed integration and an explicitly approved disposable AWS checkpoint.
No AWS writes, frontend player, new service, or migration/backfill are part of this PR.
Publication must supply the immutable private manifest and mandatory SHA-256 pin.
The finaliser reads accepted sealed evidence, not private manifests in a browser or
assistant prompt. Incomplete results retain safe saved events and have a null score.
Keep admission disabled until these dependencies and an approved AWS checkpoint are complete.
Local Docker remains a test tool, not a second platform runtime.
