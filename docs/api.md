# API contract

Status: proposed `/v1` contract, version 0.2. [OpenAPI](../packages/contracts/openapi.json)
owns REST routes and wire schemas. [Public schemas](../packages/contracts/schemas/public.schema.json)
also define the terminal gateway frames. This document owns stateful behaviour, the
gateway protocol, and error semantics. No endpoint or gateway is implemented.

Version 0.2 replaces the pre-implementation 0.1 contract, which described a simulated
engine with typed actions. Nothing depended on 0.1.

## Common rules

The REST API is a Regional API Gateway REST API with Lambda handlers. Authenticated
routes require a Cognito-issued bearer token. The server derives the user ID from the
verified token, never from a request body. Ownership failures use `404` so the API does
not reveal another learner's session. Missing identity uses `401`. Content outside the
learner's plan uses `403 ACCESS_DENIED`.

Mutations that create, end, or release something carry `requestId` as a UUID. A request
ID identifies one logical request, not a transport attempt. Clients keep it until the
outcome is known. Repeating it with the same body returns the saved result with
`replayed: true`. Reusing it with a different body is `409 IDEMPOTENCY_CONFLICT`.

Errors contain `code`, `message`, and `requestId`, which is the client request ID for
mutations and a server correlation ID otherwise. Errors never contain the planted fault,
validator or probe definitions, unreleased hints, or review findings.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_REQUEST` |
| 401 | `UNAUTHENTICATED` |
| 403 | `ACCESS_DENIED` |
| 404 | `NOT_FOUND` |
| 409 | `IDEMPOTENCY_CONFLICT`, `ACTIVE_SESSION_EXISTS`, `SESSION_NOT_READY`, `SESSION_ACTIVE`, `SESSION_TERMINAL`, `DEBRIEF_PENDING`, `HINT_NOT_AVAILABLE`, `TURN_IN_PROGRESS` |
| 422 | `VERSION_UNAVAILABLE`, `NO_HINTS_REMAINING` |
| 429 | `LIMIT_EXCEEDED` |
| 503 | `CAPACITY_UNAVAILABLE`, with `retryAfterSeconds` |
| 500 | `INTERNAL_ERROR` |

`PROVIDER_FAILED` appears only inside a `turn_failed` stream event.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /v1/catalog` | Public metadata for published Free and Pro content, with filters |
| `GET /v1/me` | Current plan and active session |
| `GET /v1/learn/{id}` | A published Learn entry after an entitlement check |
| `POST /v1/sessions` | Start a Challenge attempt in a dedicated environment task |
| `GET /v1/sessions` | List owned first attempts and retries |
| `GET /v1/sessions/{id}` | Status, alert, recovery state, time limit, and hints |
| `POST /v1/sessions/{id}/terminal-tickets` | Issue a short-lived ticket for the terminal gateway |
| `POST /v1/sessions/{id}/end` | End an active attempt and stop its environment |
| `POST /v1/sessions/{id}/hints` | Release the next authored hint |
| `GET /v1/sessions/{id}/timeline` | Per-command, monitor, assistance, and lifecycle events |
| `GET /v1/sessions/{id}/debrief` | Debrief and raw score components |
| `GET /v1/sessions/{id}/playback` | Playback manifest with short-lived recording links |
| `POST /v1/sessions/{id}/messages` | Start or reattach to a Challenge assistant turn through SSE |
| `GET /v1/sessions/{id}/messages/{turnId}` | Saved Challenge assistant turn |
| `GET /v1/reviews/{id}` | Review diff and context, without findings |
| `POST /v1/reviews/{id}/submissions` | Submit flagged lines and release findings |
| `GET /v1/review-submissions` | List owned review submissions |
| `GET /v1/review-submissions/{id}` | Owned submission and released findings |
| `POST /v1/review-submissions/{id}/messages` | Start or reattach to a Code Review debrief assistant turn |
| `GET /v1/review-submissions/{id}/messages/{turnId}` | Saved Code Review assistant turn |

Terminal and dashboard traffic does not use these routes. It uses the gateway protocol
below.

## Catalogue, account, and Learn

The catalogue is public. It lists Free and Pro entries with their `plan`, so the client
can show locked items. It lists only filter values represented by published content and
never returns private content locations. `GET /v1/me` returns the plan the server will
enforce. The client uses it for display only.

Free Learn entries are static pages served through CloudFront. `GET /v1/learn/{id}`
returns any published entry the caller's plan includes, and `403` for a Pro entry on
the Free plan. Entry HTML is rendered and sanitised at build time.

## Challenge sessions

### Start

`POST /v1/sessions` takes `requestId`, `challengeId`, and `challengeVersion`. The handler:

1. Verifies identity, that the version is the current published version
   (`422 VERSION_UNAVAILABLE` otherwise), and that the plan includes the Challenge.
2. Commits one DynamoDB transaction: the start receipt, the learner's active-session
   lock, and the session record in `provisioning`. The receipt and lock are conditional
   on absence. An existing lock returns `409 ACTIVE_SESSION_EXISTS` with `activeSessionId`.
3. Calls ECS `RunTask` with the Challenge's task definition revision, which pins both
   images by digest. The request ID is the `clientToken`, and the session ID is
   `startedBy` and a tag. It then stores the task ARN.
4. Creates the session's EventBridge Scheduler job at the provisioning deadline.
5. Returns `200` with the session in `provisioning`.

A repeated request returns the saved session. If the saved session has no task ARN
because the first handler stopped between steps 2 and 3, the retry calls `RunTask`
again with the same client token, which returns the existing task instead of a second
one. A capacity or quota rejection marks the session `error` with `start_failed`,
releases the lock, and returns `503 CAPACITY_UNAVAILABLE`.

The attempt label is `first` when the learner has no earlier attempt of that Challenge
ID with an outcome other than `error`. Otherwise it is `retry` with the next number.
Environment faults never use up the first attempt.

### Readiness and status

The client polls `GET /v1/sessions/{id}` with backoff until the status leaves
`provisioning`. A session becomes `ready` when the task is running and the monitor
container reports healthy. The monitor passes its health check only after it confirms
the planted fault is present: validators fail and health probes pass. The lifecycle
handler then records `readyAt` and the task's private address, and moves the Scheduler
job to `readyAt` plus the time limit. If the deadline passes first, the session ends as
`error` with `start_failed`.

`timeLimitSeconds` comes from the manifest for the Free plan and is extended for Pro.
The extension is a platform setting, not yet chosen. `recovery` is an aggregate of all
validators and is null until the session is ready. It never names individual
validators. `hints.nextAvailableAt` is `readyAt` plus the next hint's authored delay.

| Status | Meaning | Terminal |
| --- | --- | --- |
| `provisioning` | Task requested, not yet verified | No |
| `ready` | Terminal and dashboard available, clock running | No |
| `resolved` | Every validator passed for its sustain period | Yes |
| `failed` | Time limit reached, or the challenge container exited | Yes |
| `ended` | Learner ended the attempt | Yes |
| `abandoned` | Heartbeat missed while no learner was connected | Yes |
| `error` | Environment never became ready | Yes |

The first terminal outcome wins through a conditional write. A later outcome, such as
the time limit firing just after resolution, has no effect.

### Terminal tickets

`POST /v1/sessions/{id}/terminal-tickets` returns a ticket and the gateway URL. It
returns `409 SESSION_NOT_READY` while provisioning and `409 SESSION_TERMINAL` after the
outcome. A ticket is 256 random bits in base64url. DynamoDB stores only its SHA-256
hash, with the owner, session, and an expiry of 60 seconds (proposed). Each connection
needs a new ticket. The ticket never appears in a URL.

### End

`POST /v1/sessions/{id}/end` moves an active session to `ended` with `learner_ended`
through a conditional write and a receipt. Ending a session that already has an outcome
returns that outcome. The finaliser then stops the task.

### Hints

`POST /v1/sessions/{id}/hints` releases the next authored hint and records an
assistance event. It returns `409 HINT_NOT_AVAILABLE` with `retryAfterSeconds` before
the hint's delay has passed, and `422 NO_HINTS_REMAINING` after the last hint. The same
request ID returns the same hint. Hints are released in authored order.

### Timeline, debrief, and playback

The timeline lists events in time order, during and after the attempt. It contains the
learner's own command text and bounded output excerpts. It never contains validator or
probe definitions.

The finaliser computes the debrief once, after the session reaches an outcome. Until
then, `GET /v1/sessions/{id}/debrief` returns `409 SESSION_ACTIVE` for an active session
and `409 DEBRIEF_PENDING` with `retryAfterSeconds` while it runs. A session that never
became ready has no debrief and returns `404`. See
[Challenge environments](challenges.md) for the derivation.

`GET /v1/sessions/{id}/playback` is available with the debrief. It returns pre-signed
S3 GET URLs, valid for five minutes (proposed), for terminal recording chunks, metric
chunks, and one capture per command, plus the highlights the debrief identified. The
client requests a new manifest when the links expire.

A retry is a new `POST /v1/sessions` with a new request ID. It never changes the first
attempt's session, debrief, or first-attempt progress.

## Terminal gateway protocol

The browser connects to `wss://terminal.<domain>/v1/terminal`. The ALB terminates HTTPS
and forwards the WebSocket to any gateway copy. Binary frames carry raw terminal bytes
in both directions. Text frames carry JSON that matches `GatewayClientMessage` or
`GatewayServerMessage`.

1. The client sends `auth` with the session ID and ticket within five seconds. The
   gateway checks the `Origin` header, consumes the ticket through a conditional delete,
   checks that the session is `ready`, and reads the task address and the per-session
   monitor secret from the session record.
2. The gateway connects to the terminal server in the challenge container and to the
   monitor, then sends `ready`. `resumed` is true when the shell already existed. The
   terminal server keeps one shell per session across reconnects.
3. The client sends `resize` with columns and rows, and `heartbeat` every 20 seconds
   (proposed), which is below the ALB's default 60-second idle timeout. At most every
   30 seconds, the gateway updates the session's `lastSeenAt` through a write that is
   conditional on the session still being active. A failed condition means the session
   has an outcome, so the gateway sends `status` and closes.
4. The gateway sends `metrics` every five seconds (proposed) with the latest sample,
   cumulative request counters, and the aggregate recovery state. It sends `timeline`
   when a command completes or a monitor signal occurs, and `status` when the session
   status changes.
5. `run_proposal` runs a confirmed assistant proposal. The gateway checks that the
   proposal belongs to this session and learner, is pending, and has not expired. It
   checks that the shell is idle at a prompt, marks the proposal run through a
   conditional write, and types the command followed by Enter. The resulting command
   event has `source: assistant` and the proposal ID.

Only one terminal connection per session is active. A new authenticated connection
replaces the old one, which receives `error` with `REPLACED` and closes. Other `error`
codes are `AUTH_FAILED`, `TICKET_EXPIRED`, `SESSION_NOT_READY`, `SESSION_TERMINAL`,
`TERMINAL_BUSY` when the shell is running a command, `PROPOSAL_UNAVAILABLE`,
`RATE_LIMITED` when input exceeds the per-session rate, and `INTERNAL_ERROR`. The
gateway never forwards browser frames to the monitor.

## Assistant turns

`POST /v1/sessions/{id}/messages` takes `requestId` and `text` and returns
`text/event-stream`. Event types are `turn_started`, `text_delta`, `proposal`,
`turn_completed`, and `turn_failed`. `text_delta` is provisional. The request ID is the
turn ID, so recovery does not depend on receiving the first event.

The server validates identity, ownership, and session status before opening the
stream. It persists the turn before calling the provider. A repeated request ID
reattaches to the saved turn and never calls the provider again. One turn per session
runs at a time, and another returns `409 TURN_IN_PROGRESS`. After the stream opens,
failures use `turn_failed` because the HTTP status cannot change. Use `fetch` with a
streamed response body, since `EventSource` cannot send a POST body or an
authorization header.

This route never runs a command. A proposal waits for the learner to confirm it in the
workspace, which sends `run_proposal` through the gateway. Proposals expire after ten
minutes (proposed) or when the session ends. See [LLM integration](llm.md).

`POST /v1/review-submissions/{id}/messages` follows the same stream rules for Code
Review debriefs and is available only after submission. Its turns never propose
commands.

## Code Review

`GET /v1/reviews/{id}` returns the diff, context, language, tier, and plan after an
entitlement check. It never returns findings.

`POST /v1/reviews/{id}/submissions` takes `requestId`, `exerciseVersion`, and up to 50
flags. Each flag names a file, a side, a line that exists in the diff, and a short
concern. Flags on lines not in the diff are `400`. A version that is no longer published
is `422 VERSION_UNAVAILABLE`. The Lambda handler matches flags against the reference
ranges:

- A finding is found when any flag has the same file and side and a line within its
  inclusive range.
- One flag can match overlapping findings.
- Flags that match no finding are listed in `unmatchedFlags`. They carry no penalty.

The handler saves the submission before returning the findings and their explanations.
Written concerns are stored and shown beside the reference explanations. They are not
graded. A later submission for the same exercise has `answerInformed: true`.

## Limits and compatibility

Paginated reads use opaque cursors bound to the owner, resource, and query. The default
page size is 50 and the maximum is 100. Reusing a cursor with a changed query is `400`.

The server enforces per-learner limits on session starts, concurrent sessions,
assistant turns, and hint requests before any side effect. The proposed concurrent
limit is one active session per learner. Other values are open. Request text and
command bounds are in the schemas and the [data model](data-model.md).

Breaking wire changes require a new API version or an explicitly reviewed pre-release
contract update.
