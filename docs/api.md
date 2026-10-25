# API contract

Status: version 0.2 contract with a partially implemented API.
[OpenAPI](../packages/contracts/openapi.json) owns REST routes and wire schemas.
[Public schemas](../packages/contracts/schemas/public.schema.json) also define terminal
Gateway frames. The reference Challenge handlers from session start through result reads
are implemented. An operator-seeded AWS checkpoint on 15 October 2026 exercised the real
CloudFront terminal path and invoked ticket and result handlers locally against managed
data. It did not exercise Cognito, API Gateway, or session start. Catalogue, account
Challenge assistant turns are implemented locally. Code Review assistant routes are not implemented. Confirmed Challenge command proposals are implemented locally. Session and review history reads are implemented locally. Code Review reads and submissions are implemented locally. Learn reads are implemented locally.
All runtime routes remain default-off, and no public API or Gateway is currently deployed.

Version 0.2 replaces the pre-implementation 0.1 contract, which described a simulated
engine with typed actions. Nothing depended on 0.1. This pre-release revision adds
recording status and permits a null debrief score when recording is incomplete. Evidence
uses `status` instead of `found`. `possibleHarmfulActions` replaces `harmfulActions`,
outages no longer have `afterCommandSeq`, and `observedOutages` replaces
`selfInflictedOutages`. Duration components accept fractional seconds. Assistant turns
add a required `expiresAt` and a `TURN_INTERRUPTED` stream error. Clients
must handle these fields before the first runtime release. This revision also replaces
proposal `run` with `dispatching`, `accepted`, and `unknown`, adds a `proposal_status`
gateway frame, requires capture interval timestamps in playback, and defines
`RECORDING_EXPIRED` for playback after the recording retention boundary.

## Common rules

The REST API is a Regional API Gateway REST API with Lambda handlers. Authenticated
routes require a Cognito-issued ID token. API Gateway verifies the configured user pool;
the action wrapper also requires `token_use=id` and the exact configured app-client
`aud`. The server derives the user ID only from the verified `sub`, never from a request
body. The browser uses authorization code with PKCE S256 and a public client with no
secret. Ownership failures use `404` so the API does
not reveal another learner's session. Missing identity uses `401`. Content outside the
learner's plan uses `403 ACCESS_DENIED`.

The checkpoint API permits one exact HTTPS browser origin, or one exact localhost HTTP
origin for local development. Proxy responses, gateway-generated errors, and
unauthenticated preflight responses return only that configured origin. They do not use a
wildcard, reflect the request Origin, or enable credentialed CORS. The bearer token is sent
in the `Authorization` header.

Mutations that create, end, or release something carry `requestId` as a UUID. A request
ID identifies one logical request, not a transport attempt. Clients keep it until the
outcome is known. Repeating it with the same body returns the saved result with
`replayed: true` on success. Confirmed launch errors keep their saved error response.
Reusing it with a different body is `409 IDEMPOTENCY_CONFLICT`.

After identity, request-shape, and ownership checks, read the receipt by owner, operation,
and request ID before checking current publication, plan, or new-operation limits.
The hash includes the target resource and version. A matching receipt returns the saved
result even if a new version was published or the current plan expired. A changed body
still conflicts. Only a missing receipt proceeds to new-operation validation. A concurrent
receipt creation is resolved by rereading the committed receipt, not repeating effects.

Starting an attempt or submitting a review saves an access grant for that resource and
its admitted limits. Plan expiry does not revoke the existing attempt, hints, bounded
assistant access, cleanup, or saved result while retained. It affects new paid operations
and unopened content. Every request still checks identity, ownership, the saved grant,
and the resource state. This is not access to other paid content.

Errors contain `code`, `message`, and `requestId`, which is the client request ID for
mutations and a server correlation ID otherwise. Errors never contain the planted fault,
validator or probe definitions, unreleased hints, or review findings.

| Status | Codes                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`, `INVALID_CURSOR`                                                                                                                                     |
| 401    | `UNAUTHENTICATED`                                                                                                                                                       |
| 403    | `ACCESS_DENIED`                                                                                                                                                         |
| 404    | `NOT_FOUND`                                                                                                                                                             |
| 409    | `IDEMPOTENCY_CONFLICT`, `ACTIVE_SESSION_EXISTS`, `SESSION_NOT_READY`, `SESSION_ACTIVE`, `SESSION_TERMINAL`, `DEBRIEF_PENDING`, `HINT_NOT_AVAILABLE`, `TURN_IN_PROGRESS` |
| 410    | `RECORDING_EXPIRED`                                                                                                                                                     |
| 422    | `VERSION_UNAVAILABLE`, `NO_HINTS_REMAINING`                                                                                                                             |
| 429    | `LIMIT_EXCEEDED`                                                                                                                                                        |
| 503    | `CAPACITY_UNAVAILABLE`, with `retryAfterSeconds`                                                                                                                        |
| 500    | `INTERNAL_ERROR`                                                                                                                                                        |

`PROVIDER_FAILED` and `TURN_INTERRUPTED` appear only inside a `turn_failed` stream event.

## Routes

| Route                                               | Purpose                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/catalog`                                   | Public metadata for published Free and Pro content, with filters |
| `GET /v1/me`                                        | Current plan and active session                                  |
| `POST /v1/demo-upgrade`                             | Approved presentation-only Pro activation without payment        |
| `GET /v1/learn/{id}`                                | A published Learn entry after an entitlement check               |
| `POST /v1/sessions`                                 | Start a Challenge attempt in a dedicated environment task        |
| `GET /v1/sessions`                                  | List owned first attempts and retries                            |
| `GET /v1/sessions/{id}`                             | Status, alert, recovery state, time limit, and hints             |
| `POST /v1/sessions/{id}/terminal-tickets`           | Issue a short-lived ticket for the terminal gateway              |
| `POST /v1/sessions/{id}/end`                        | End an active attempt and stop its environment                   |
| `POST /v1/sessions/{id}/hints`                      | Release the next authored hint                                   |
| `GET /v1/sessions/{id}/timeline`                    | Per-command, monitor, assistance, and lifecycle events           |
| `GET /v1/sessions/{id}/debrief`                     | Debrief and raw score components                                 |
| `GET /v1/sessions/{id}/playback`                    | Playback manifest with short-lived recording links               |
| `POST /v1/sessions/{id}/messages`                   | Start or reattach to a Challenge assistant turn through SSE      |
| `GET /v1/sessions/{id}/messages/{turnId}`           | Saved Challenge assistant turn                                   |
| `GET /v1/reviews/{id}`                              | Review diff and context, without findings                        |
| `POST /v1/reviews/{id}/submissions`                 | Submit flagged lines and release findings                        |
| `GET /v1/review-submissions`                        | List owned review submissions                                    |
| `GET /v1/review-submissions/{id}`                   | Owned submission and released findings                           |
| `POST /v1/review-submissions/{id}/messages`         | Start or reattach to a Code Review debrief assistant turn        |
| `GET /v1/review-submissions/{id}/messages/{turnId}` | Saved Code Review assistant turn                                 |

Terminal and dashboard traffic does not use these routes. It uses the gateway protocol
below.

## Catalogue, account, and Learn

Learn reads validate immutable content references and current Pro access before private
object reads. Free bodies are built as static assets. No AWS lesson is published by
this change.

The implemented catalogue is public. It lists Free and Pro entries with their `plan`, so the client
can show locked items. It lists only filter values represented by published content and
never returns private content locations. `GET /v1/me` returns the plan the server will
enforce. The client uses it for display only. Missing or expired grants return Free. An active
session ID represents the admission lock, including cleanup after an outcome. Both
bootstrap routes remain default-off until the runtime is enabled. See the
[bootstrap decision](decisions/learner-bootstrap.md).

Free Learn entries are static pages served through CloudFront. `GET /v1/learn/{id}`
returns any published entry the caller's plan includes, and `403` for a Pro entry on
the Free plan. Entry HTML is rendered and sanitised at build time.

## Presentation-only upgrade

Presentation-only activation uses `POST /v1/demo-upgrade` with `MutationRequest`.
It is default-off and permits only an operator-approved learner allowlist until a
fixed UTC expiry. Its transaction saves a duplicate-safe receipt and updates only
that learner's Free or expired plan. Current Pro grants remain unchanged. Responses
contain `changed` and `expiresAt`, not payment or subscription status. The browser
reads `GET /v1/me` before displaying current Pro access. Its optional
`demoUpgradeExpiresAt` field advertises a matching open demo window; missing or null
means unavailable. Activation does not start a task or change existing attempts.
See [demo Pro grants](decisions/demo-pro-grants.md).

## Challenge sessions

### Start

The current implementation covers admission, launch, committed readiness, outcomes,
learner liveness, deadline repair, bounded drain, and confirmed cleanup. It is tested
locally through DynamoDB Local and fake ECS and Scheduler ports. New lifecycle actions
and triggers remain disabled. The authenticated route is defined, but StartSession still
has zero reserved concurrency. Shared lifecycle routines
are ordinary code, not one Lambda invoking another Lambda. Ready-attempt lock release
has debrief/finalisation code, bounded playback exports, and separate owner
read routes. These routes remain disabled. The session-start and public REST paths still
require an approved AWS checkpoint through API Gateway and Cognito.

`POST /v1/sessions` takes `requestId`, `challengeId`, and `challengeVersion`. The handler:

1. Verifies identity, shape, and ownership, then resolves an existing start receipt.
   Only a new request checks that the version is currently published
   (`422 VERSION_UNAVAILABLE` otherwise), that the plan includes the Challenge, and
   that new-operation limits permit admission. A published Challenge must have an
   explicit Pro time limit greater than its Free limit and an `opsreplay-` task-definition
   family, or it is unavailable to both plans. Its private admission pins also require
   the canonical manifest SHA-256. Publication must first save the matching immutable
   private manifest item. It is never returned to the browser.
2. Commits one DynamoDB transaction: the start receipt, the learner's active-session
   lock, the session record in `provisioning`, including its access grant and limits,
   and a separate indexed lifecycle item. The receipt and lock are conditional
   on absence. An existing lock returns `409 ACTIVE_SESSION_EXISTS` with `activeSessionId`.
3. Invokes the shared lifecycle routine, which first creates the recovery callback at
   `launchRecoveryDeadline`, then the timeout callback at `provisioningDeadline`.
   Both must exist before launch. Recovery is created first so an interrupted setup
   still has a callback after the task-discovery window.
4. Creates a per-session TLS key pair. It writes the saved monitor secret and base64
   certificate and key to a private, encrypted S3 environment file, then stores only the
   public certificate in the private session record. It calls ECS `RunTask` with the
   persisted arguments and stores the task ARN. The arguments pin the task definition,
   images, bootstrap-file reference, and network settings. They contain no secret or
   private key. The ECS agent reads the file with the task execution role. The
   environment task has no task IAM role.
   The server-generated session ID is the `clientToken`, `startedBy`, and a tag.
5. Returns `200` with the session in `provisioning`.

An ECS `RUNNING` task-state action reads the ENI private IPv4 address. After it verifies
the saved cluster, task ARN, certificate, status, and provisioning deadline, it stores
the address and adds the session to the sparse recording-work index. This action is
bundled and tested locally and in the 15 October AWS checkpoint. Its EventBridge rule is
defined behind the default-off runtime gate.

A repeated request returns the saved session and invokes the same provisioning routine.
It repairs both callbacks even when the ARN is already saved. If the ARN is missing, it
repeats `RunTask` with exactly the same arguments and token, only before the provisioning
deadline. The expiry action discovers a late active task by its saved `startedBy` value.
The disabled session stream and minute sweep invoke the same saved-argument
provisioner without a client retry. They also repair missed recording-work publication
from the saved task's ENI address. The sweep uses a persistent bounded pagination cursor.

The deadline is persisted in the start transaction, proposed at three minutes after
creation and within ECS's client-token validity window. After it, no handler launches
a task for that receipt. The session becomes `error` with `start_failed`. A late task
is stopped by the lifecycle routine. An uncertain launch result stays `provisioning`
until recovered or expired. A confirmed resource-capacity rejection returns
`503 CAPACITY_UNAVAILABLE`. Other confirmed rejections return `500 INTERNAL_ERROR`.
Both atomically save the private failure classification, mark `error/start_failed`, and
release the lock. Repeating the same request ID replays the same error, without another
launch. After a capacity rejection, wait `retryAfterSeconds` and use a new request ID.
A confirmed configuration rejection advises a later new request. Unknown outcomes still
advise retrying the same ID. These failures do not consume the learner's first attempt.

Scheduler invokes reconciliation asynchronously. Its delivery retries do not retry
function errors. Provisioning callbacks check the saved deadline, and ready attempts
use a separate timer. Reconciliation discovers uncertain launches by `startedBy` and
waits for the saved launch-recovery window if no task is known. A missing known task
is not STOPPED confirmation. The minute sweep backs up missed callbacks and failed
cleanup. Never-ready lock release follows confirmed stop and timer deletion; ready
locks remain held for debrief finalisation. CDK defines async retries and operational
alarms, with the new triggers disabled. The 15 October 2026 operator-seeded AWS
checkpoint exercised the ready-session success path after setup. Normal session start,
failure recovery, and concurrent load remain unvalidated.

The attempt label is `first` when the learner has no earlier attempt of that Challenge
ID with an outcome other than `error`. Otherwise it is `retry` with the next number.
Environment faults never use up the first attempt.

Admission normalises UUID request IDs to lower case. Its hash covers `challengeId` and
`challengeVersion` in a fixed order. JSON property order and whitespace do not change
request identity. Bodies larger than 8 KiB decoded are rejected before storage access.
The transaction checks that content, plan, and progress still match the snapshots used
for admission. Known conditional conflicts are retried at most three times. Other write
failures recheck the receipt and otherwise return a generic `500`. Clients keep the same
request ID after an uncertain response. The handler reserves one second of the Lambda
duration for its response and final log. A shared deadline signal cancels DynamoDB calls
and retry delays before that margin.

### Readiness and status

The separate `GET /v1/sessions/{id}` Lambda is implemented and tested locally. It
validates the Cognito identity, GET route, empty body, and UUID before storage access.
It strongly reads the session `STATE` item, hides missing or foreign sessions with the
same `404`, validates the saved record and access grant, and returns only `SessionView`.
The grant's time limit must match the view. Current plan expiry or content withdrawal
cannot revoke this existing-session read. Private task addresses, secrets, launch
arguments, validators, and unreleased hints never enter the response or logs.

Status reads have no lifecycle effects: they do not launch tasks, mark readiness,
release hints, claim leases, or update `lastSeenAt`. Polling returns the saved state, not
a computed outcome. Responses use `Cache-Control: no-store`. Invalid requests return
`400 INVALID_REQUEST`, and storage or record-validation failures return a generic `500`.
The Lambda uses bounded DynamoDB requests and reserves one second for its response.
Its CDK route shares the existing Cognito API, but has a separate read-only role,
bundle, log group, timeout, and configurable concurrency and method-throttling limits.
The routes are absent, and the function has zero reserved concurrency, while
`EnableGatewayPath=false`. Readiness writers are locally implemented. CORS is defined for
one exact origin; managed Cognito and CORS behaviour still require AWS validation.

The client polls `GET /v1/sessions/{id}` with capped backoff and jitter until the status
leaves `provisioning`. After `429 LIMIT_EXCEEDED`, it retries with capped exponential
backoff and full jitter. Polling is not a learner heartbeat.

A session becomes `ready` when the task is running, the monitor container reports healthy,
and a gateway has acknowledged recording ownership. The
monitor passes its health check only after it confirms the planted fault is present:
aggregate recovery fails and health probes pass. The lifecycle handler saves the task's private
address for recorder attachment. The Gateway commits the initial terminal and monitor
pages, then commits the measurement origin as `readyAt`. Reconciliation creates a separate
ready deadline timer at `readyAt` plus the saved time limit. It repairs a missing or stale
timer from the saved session. Every timer callback reads the current deadline before
acting, so a stale provisioning timer cannot end a ready session early. The sweep also
checks deadlines if a schedule is missing. If the provisioning deadline passes first,
the session ends as `error` with `start_failed`.

`timeLimitSeconds` comes from the manifest for the Free plan and is extended for Pro.
The extension is a platform setting, not yet chosen. `recovery` is an aggregate of all
validators and is null until the session is ready. It never names individual
validators. `hints.nextAvailableAt` is `readyAt` plus the next hint's authored delay.

| Status         | Meaning                                                | Terminal |
| -------------- | ------------------------------------------------------ | -------- |
| `provisioning` | Task requested, not yet verified                       | No       |
| `ready`        | Terminal and dashboard available, clock running        | No       |
| `resolved`     | Every validator passed for its sustain period          | Yes      |
| `failed`       | Time limit reached, or the challenge container exited  | Yes      |
| `ended`        | Learner ended the attempt                              | Yes      |
| `abandoned`    | Heartbeat missed while no learner was connected        | Yes      |
| `error`        | Startup failed or the platform stopped the environment | Yes      |

The first terminal outcome wins through a conditional write. A later outcome, such as
the time limit firing just after resolution, has no effect.

### Terminal tickets

`POST /v1/sessions/{id}/terminal-tickets` returns a ticket and the gateway URL. It
returns `409 SESSION_NOT_READY` while provisioning and `409 SESSION_TERMINAL` after the
outcome. A ticket is 256 random bits in base64url. DynamoDB stores only its SHA-256
hash, with the owner, session, and an expiry of 60 seconds. A conditional transaction
rechecks that the owned session is still `ready` before it writes the ticket. Each
connection needs a new ticket. The ticket never appears in a URL. The deployed API
Gateway route owns request throttling and returns `429 LIMIT_EXCEEDED` without invoking
the Lambda. The browser must retry a throttled ticket request with capped exponential
backoff and full jitter. It must obtain a new ticket after a failed connection attempt
because it cannot know whether Gateway consumed the previous ticket.

### End

The separate, disabled `POST /v1/sessions/{id}/end` action accepts only `requestId`.

The end action returns `EndSessionResponse`, an envelope containing `session` only.
Unlike start, it does not expose a replay flag. The pre-release OpenAPI response was
corrected to match the existing handler. Repeat the same request ID after an uncertain
end response; read the saved session to confirm the outcome.

It checks Cognito ownership and saves `ended/learner_ended` with an atomic receipt and
fixed recording cutoff. A request at or after the saved time limit returns
`failed/time_limit` at that deadline. Ending an attempt that already has an outcome
returns it and saves the receipt. Retries cannot change the outcome. The Gateway drains
before lifecycle cleanup stops the task, with a fixed 30-second coverage deadline.
A saved coverage receipt permits cleanup while task-independent sealing continues under
a separate 24-hour bound. Missing recorder observations allow a five-minute recovery
window, then use `error/recorder_unavailable`. This is not evidence of environment exit.
Fixed errors expose no
private state. See [the lifecycle](challenges.md#lifecycle).

### Hints

`POST /v1/sessions/{id}/hints` releases the next authored hint and records an
assistance event. It returns `409 HINT_NOT_AVAILABLE` with `retryAfterSeconds` before
the hint's delay has passed, and `422 NO_HINTS_REMAINING` after the last hint. The same
request ID returns the same saved response, even after the session ends or the current
plan expires. The learner supplies no hint ID. The action uses the admitted private hint
schedule and immutable pinned manifest, then commits the released hint, assistance event,
session counter, and request receipt in one transaction. Hints are released in authored
order. A new request is refused after the saved deadline, a terminal outcome, or a durable
recovery observation. The separate Lambda and route have zero reserved concurrency while
`EnableGatewayPath=false`.

### Timeline, debrief, and playback

The three separate read Lambdas are implemented. During the 15 October AWS checkpoint,
their handlers were invoked locally against the managed data. Their API Gateway and
Cognito paths were not exercised. They remain default-off and are not currently deployed.
Each checks Cognito identity, request shape, session ownership, and the saved access
grant before reading result data. Current plan expiry does not revoke that grant.
Responses are `no-store`; logs contain only operation, correlation ID, result, and duration.

The timeline lists events in time order, during and after the attempt. It contains the
learner's own command text and bounded output excerpts, Monitor signals, and lifecycle
events. Hint release writes one durable assistance event in the same transaction as the
hint. Assistance actions remain in the final timeline at their actual timestamps if a
delayed recovery observation later establishes an earlier measurement cutoff. This does
not move command, Monitor, outage, or score measurements beyond the cutoff. The timeline
never contains validator or probe definitions. Live pages are provisional. Their cursors
bind the session, readiness and source identity, then seek after the last `(at, id)`.
Ordinary appends and lease changes do not invalidate them. Empty polls retain the cursor.
A readiness/source change or the switch to final paging requires a first-page restart.
Late provisional events at or before the cursor, or updates to an already returned active
command, require a refresh. Final pages retain strict snapshot binding. Terminal sessions
require a saved debrief. Timeline responses contain at most 100 events and 240 KiB of
event data. Each page rereads the bounded command and event history to sort it. This cost is not a constant-time read and needs checkpoint measurement.
At recording expiry the timeline returns `410 RECORDING_EXPIRED`; the debrief remains.

The finaliser computes the debrief once, after the session reaches an outcome and the
recording is sealed as `complete` or `incomplete`. `SessionView.recording` exposes this
separate state. Until then, `GET /v1/sessions/{id}/debrief` returns `409 SESSION_ACTIVE` for an active session
and `409 DEBRIEF_PENDING` with `retryAfterSeconds` while it runs. A session that never
became ready has no debrief and returns `404`. See
[Challenge environments](challenges.md) for the derivation.

The debrief, highlights, progress and matching-lock release commit without waiting for
playback exports. `GET /v1/sessions/{id}/playback` returns `409 PLAYBACK_PENDING` with
`retryAfterSeconds: 3` until the independent export completes. Missing or corrupt source
objects remain integrity failures, not normal pending. Once ready, it returns pre-signed
S3 GET URLs for terminal recording chunks, metric chunks, and eligible saved captures,
plus the saved highlights. `limit` is 1 to 25, default 25. Each page scans at most that
many reference rows in metrics, terminal, then capture order. An ineligible post-cutoff
capture can produce fewer links, including an empty page with `nextCursor`. Continue
until `nextCursor` is null. Cursors bind the session and saved export/capture snapshot;
they do not grant access. The client can change the page size and must renew links by
requesting the required pages again.

Before signing, the handler verifies every selected object's length and SHA-256 checksum.
All links on one page use the same signing time and `expiresAt`. They last at most five
minutes, bounded further by recording retention and temporary credential expiration.
Credentials are fixed for that request, so a provider refresh cannot change this bound. The debrief and playback both
carry the final recording status and reason. Incomplete playback lists only saved
objects, and its debrief has `score: null`. The client shows the missing-data notice.
The playback handler reads the authoritative `RECORDING` item before object references.
At or after its `retainUntil`, playback returns `410 RECORDING_EXPIRED` and creates no
links. Before that boundary, a referenced object that is missing is an integrity failure,
not normal expiry. Link expiry cannot be later than `retainUntil`. The debrief remains
available after recording expiry.

A retry is a new `POST /v1/sessions` with a new request ID. It never changes the first
attempt's session, debrief, or first-attempt progress.

## Terminal gateway protocol

The browser connects to the WSS URL returned by terminal-ticket issuance. The current
deployment definition derives `wss://<distribution>.cloudfront.net/v1/terminal` from
CloudFront. CloudFront terminates viewer TLS and uses a VPC origin to reach an internal
HTTP ALB, which forwards the WebSocket to any Gateway copy. Binary frames carry raw terminal bytes
in both directions. Text frames carry JSON that matches `GatewayClientMessage` or
`GatewayServerMessage`.

1. The client sends `auth` with the session ID and ticket within five seconds. The
   gateway checks the `Origin` header. It then atomically checks that the session is
   `ready`, consumes the unexpired ticket, and claims the next terminal input generation.
   The same operation binds the connection to the authoritative private task address.
2. The gateway installs the claimed generation at the terminal server and waits for
   acknowledgement before sending `ready`. `resumed` is true when the shell already existed. The
   terminal server keeps one shell per session across reconnects. `replayTruncated` is
   true when output continuity became uncertain before this attachment. The client must
   show that warning to the learner.
3. The client can send `resize` with columns and rows, and `heartbeat` as a liveness
   signal. While no private operation is active, the gateway sends a terminal heartbeat
   and a WebSocket Ping every 20 seconds. This keeps both relay legs active when browser
   timers are throttled. Browser heartbeat and manual input update `lastSeenAt` under the
   current input generation, with a 15-second write interval. Each connection skips
   liveness calls within that interval after success, but still authorizes every input.
   Pure transaction contention has bounded retries. Other storage failures fail closed
   before PTY input. Private keepalive and recorder renewal do not update learner liveness.
4. One non-overlapping five-second loop reads telemetry from the session partition. Each
   read is bound to the admitted session, connection ID, and input generation. On attach,
   the gateway sends the latest `metrics` frame that was committed with an accepted Monitor page
   and establishes current command and Monitor frontiers. It does not replay historical
   timeline events. Later reads send bounded `timeline` deltas and coalesce superseded
   metrics. The timeline API owns reconnect catch-up. WebSocket delivery is neither a
   durable acknowledgement nor exactly once. `TELEMETRY_UNAVAILABLE` is nonfatal after
   authorization succeeds; failed authorization and replacement fail closed. A terminal
   `status` stops the loop.
   Recording continues independently when the browser disconnects. Each input batch
   and proposal checks that the session is still active before forwarding. The outcome
   timestamp remains the scoring cutoff for any input already in flight.
5. `run_proposal` requests delivery of a confirmed proposal. The gateway checks the
   owner, session, expiry, and input generation. It conditionally changes `pending` to
   `dispatching` with a fixed delivery token before sending anything. The terminal
   server serializes this request with manual input and checks foreground Bash and prompt state.
   A private Readline binding checks the actual empty edit buffer. The token is recorded
   before one binding trigger is written. The binding records `accepted` before evaluating
   the command in the current shell. It never appends command text or Enter to typed input. The resulting command event
   has `source: assistant` and the proposal ID. Acceptance is not command success.

The terminal server rejects every input batch from an older generation after a new
generation is installed. This includes proposals, resize, and buffered input. Installation
and input handling are serialized. A delayed older installation cannot replace a newer
one. Recorder leases are separate and do not grant input rights. No gateway-to-gateway
routing service is needed. If the terminal server loses its generation or delivery
ledger, end the attempt as `error` instead of reopening an unfenced shell.

The terminal adapter must know that the shell is at a prompt with an empty edit buffer.
An idle process or a prompt marker alone is insufficient. If state is busy, non-empty,
or unknown, reject with `TERMINAL_BUSY` without sending bytes. A definite rejection can
restore `pending` using the same delivery token. Never append a proposal to typed text.
A later explicit confirmation after definite non-delivery creates a new token. Late
acknowledgements for the old token cannot change that new delivery.

`query_proposal` only reads delivery status and never dispatches a pending proposal.
`proposal_status` returns the proposal ID and current delivery status. Repeated
confirmation reads that status or queries the terminal's receipt, never resends the
command. A crash, partial PTY write, or lost acknowledgement leaves `unknown` unless a
terminal receipt or recorded command proves acceptance. Recovery may change `unknown`
to `accepted` for the same token, but cannot dispatch it again. Do not claim exactly-once
shell execution across crashes. Tell the learner to inspect output before acting again.
Bound the dispatch acknowledgement wait, proposed at five seconds. Recovery changes an
unsettled dispatch to `unknown` after that wait. A pending proposal becomes `expired` at
its expiry, while already accepted and uncertain deliveries keep their factual status.
Only accepted proposals increment `proposalsRun`, once per proposal ID. Unknown delivery
still marks the attempt as assisted through its assistant turn.

Only one terminal connection per session is active. A new authenticated connection
replaces and closes the old one. The old connection receives `error` with `REPLACED`
when its transport can accept that frame immediately. Other `error` codes are
`AUTH_FAILED`, `TICKET_EXPIRED`, `SESSION_NOT_READY`, `SESSION_TERMINAL`,
`TELEMETRY_UNAVAILABLE` for a temporary live-evidence read failure,
`TERMINAL_BUSY` when the shell is running a command, `PROPOSAL_UNAVAILABLE`,
`RATE_LIMITED` when input exceeds the per-session rate, and `INTERNAL_ERROR`. The
gateway never forwards browser frames to the monitor.

The local relay accepts only the exact terminal path without a query and an origin from
its configured allowlist. It limits a browser frame to 16 KiB and pauses WebSocket reads
while a private operation is pending. If frames were already decoded, it keeps at most
64 messages or 64 KiB. It returns `RATE_LIMITED` and closes when either bound is exceeded.
It keeps at most one 8 KiB terminal output frame pending and closes both directions if
browser delivery does not complete within one second. The relay is connected to the
Gateway process when its complete terminal configuration is present. The same listener
serves `GET /healthz`; other ordinary HTTP routes return 404. The conditional AWS
definition routes only `/v1/terminal` through CloudFront and an internal HTTP ALB,
and keeps Gateway tasks private. See the [ingress decision](decisions/cloudfront-terminal-ingress.md)
for the edge WAF, uncached terminal traffic, and explicit TLS limits.
The 15 October 2026 operator-seeded checkpoint exercised this route through CloudFront,
the internal ALB, and Gateway. Ticket issuance used a local handler invocation with
synthetic claims, so Cognito and API Gateway were not exercised.

## Assistant turns

`POST /v1/sessions/{id}/messages` takes `requestId` and `text` and returns
`text/event-stream`. Event types are `turn_started`, `text_delta`, `proposal`,
`turn_completed`, and `turn_failed`. `text_delta` is provisional. The request ID is the
turn ID, so recovery does not depend on receiving the first event.

The server validates identity, ownership, and session status before opening the
stream. It persists the turn, worker token, fixed expiry, and active-turn slot before
calling the provider. A repeated request ID reattaches to the saved turn and never
calls the provider again. Reads, new requests, and the sweep mark expired running turns
`interrupted` and release their slot conditionally. A live running turn blocks another
with `409 TURN_IN_PROGRESS`. An expired old worker cannot save a result or proposal.
`Turn.expiresAt` exposes the fixed deadline for recovery. After the stream opens,
failures use `turn_failed` because the HTTP status cannot change. Use `fetch` with a
streamed response body, since `EventSource` cannot send a POST body or an
authorization header.

Reattaching to an interrupted turn sends `turn_failed` with `TURN_INTERRUPTED`.
`GET` returns that saved terminal state. Starting another turn requires a new request
ID. Completed Challenge turns may contain one saved command proposal. Failed or interrupted turns contain none.

This route never runs a command. A proposal waits for the learner to confirm it in the
workspace, which sends `run_proposal` through the gateway. Proposals expire after ten
minutes or when the session ends. See [LLM integration](llm.md).

`POST /v1/review-submissions/{id}/messages` follows the same stream rules for Code
Review debriefs and is available only after submission. Its turns never propose
commands.

## Code Review

`GET /v1/reviews/{id}` returns the diff, context, language, tier, and plan after an
entitlement check. It never returns findings.

`POST /v1/reviews/{id}/submissions` takes `requestId`, `exerciseVersion`, and up to 50
flags. Each flag names a file, a side, a line that exists in the diff, and a short
concern. Flags on lines not in the diff are `400`. A version that is no longer published
is `422 VERSION_UNAVAILABLE` for a new request only. Resolve the owned submission receipt
first, so a lost response remains recoverable after content publication or plan expiry.
The Lambda handler matches flags against the reference
ranges:

- A finding is found when any flag has the same file and side and a line within its
  inclusive range.
- One flag can match overlapping findings.
- Flags that match no finding are listed in `unmatchedFlags`. They carry no penalty.

The handler saves the submission before returning the findings and their explanations.
Written concerns are stored and shown beside the reference explanations. They are not
graded. A later submission for the same exercise has `answerInformed: true`.

## Limits and compatibility

Paginated reads use opaque cursors, not access tokens. Timeline and playback cursors
bind the session and snapshot; ownership is checked independently on every page.
Timeline `limit` is 1 to 100, default 100. Playback `limit` is 1 to 25, default 25.
Other proposed paginated reads default to 50 with a maximum of 100. Invalid or stale
cursors, duplicate parameters, unknown parameters, and non-decimal limits return `400`.

The server enforces per-learner limits on session starts, concurrent sessions,
assistant turns, and hint requests before any side effect. The proposed concurrent
limit is one active session per learner. Other values are open. Request text and
command bounds are in the schemas and the [data model](data-model.md).

Breaking wire changes require a new API version or an explicitly reviewed pre-release
contract update.

Browser playback validates metric objects as `PlaybackMetrics` and watched-file
capture objects as `PlaybackCapture` in the public schema. These describe the
existing signed-object formats. Terminal objects use asciicast v2. The browser
never connects recorded input to a live terminal.
