# API contract

Status: proposed `/v1` contract. [OpenAPI](../packages/contracts/openapi.json) owns
routes and wire schemas. This document owns stateful behaviour and error semantics.
The local API implements Challenge session creation, reads, history, actions, end,
debrief, replay, comparison, and a Challenge catalogue. Learn, Code Review, and
conversation routes remain planned. See [ADR 002](decisions/002-local-persistence.md)
for the local identity boundary.

## Common rules

Authenticated routes require the identity token configured for the deployment.
The server derives the user ID from verified identity, never from a request body.
Ownership failures use `404` to avoid revealing another user's session. Missing
identity uses `401`. Missing content entitlement uses `403`.

Locally, signed cookies provide identity. The browser sends its expected learner
in `X-OpsReplay-Owner`. If present, the header must match the cookie. It never
selects or authorizes a learner. This rejects stale-tab requests after account
switching. All local mutations require `X-OpsReplay-Client: web`.

All mutation bodies carry `requestId` as a UUID. Session mutations also carry
`expectedVersion`. A request ID identifies a logical request, not a retry attempt.
Clients retain it until the outcome is known. Replay of a successful request returns
the saved action output and `replayed: true`. Reuse with different arguments is `409`.

Successful session mutations return the resulting visible session and version.
Clients replace their current projection only if the received version is at least
the version already shown. Retries return saved action output/events and the
current session projection. Original observations retain their old versions.
`executedVersion` identifies the original action commit even when the current
session is newer. A replayed receipt does not represent a second execution.

Errors contain `code`, `message`, and `requestId`. They may contain `currentVersion`
on an owned-state conflict. Errors never contain a hidden root cause or a private
rule expression. Schema errors are `400`, unavailable/prerequisite failures are
`422`, version/request conflicts are `409`, and capacity limits are `429`.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /v1/catalog` | Public published content metadata and available filters |
| `GET /v1/learn/{id}` | Free published learning entry |
| `POST /v1/sessions` | Create an owned Challenge session for an accessible version |
| `GET /v1/sessions` | List owned sessions and replay attempts for resume/history |
| `GET /v1/sessions/{id}` | Current visible state, revealed evidence, allowed operations |
| `GET /v1/sessions/{id}/events` | Cursor-paginated visible logical history |
| `POST /v1/sessions/{id}/actions` | Execute a direct or confirmed LLM action |
| `POST /v1/sessions/{id}/end` | End an attempt without changing simulated time |
| `GET /v1/sessions/{id}/debrief` | Deterministic terminal feedback |
| `POST /v1/sessions/{id}/replays` | Create an informed practice child from an eligible checkpoint |
| `GET /v1/sessions/{id}/comparison` | Compare a replay with its parent from the same checkpoint |
| `POST /v1/sessions/{id}/messages` | Start or reconnect to a conversational turn through SSE |
| `GET /v1/sessions/{id}/messages/{turnId}` | Retrieve saved turn state and committed action results |
| `GET /v1/reviews/{id}` | Accessible published review diff and context, excluding answers |
| `POST /v1/reviews/{id}/submissions` | Save a final review and release prepared findings |
| `GET /v1/review-submissions` | List owned review submissions |
| `GET /v1/review-submissions/{id}` | Retrieve an owned submission and released feedback |

`GET` calls have no simulated cost. Opening a newly requested metric or log uses
the action route, while opening already stored evidence is a local/read operation.
The catalogue never returns private definition locations.
Catalogue filters accept mode, difficulty, domain, and language. Responses list
only filter values represented by published content.

The session response contains the latest observation for each revealed evidence
ID. Each observation has a unique observation ID, tick, and committed version.
Event pages preserve earlier observation payloads without growing the current
session response indefinitely. Never replace a saved observation in the event log.

## Actions

[tools.json](../packages/contracts/tools.json) defines operation schemas and kinds.
The scenario determines allowed targets, parameters, costs, and prerequisites.
The session exposes operation offers with safe argument schemas, display labels,
and costs. The frontend renders those offers rather than guessing arguments.
Offers exclude actions whose evidence prerequisites are not yet satisfied.
The backend repeats all checks at execution time.
The first registry supports metrics, logs, deployments, diffs, runbooks,
architecture, status, rollback, scale, restart, and explicit time advance.

```json
{
  "requestId": "11111111-1111-4111-8111-111111111111",
  "expectedVersion": 0,
  "source": "direct",
  "command": {
    "tool": "get_metric",
    "arguments": {
      "service": "database",
      "metric": "connections",
      "windowTicks": 5
    }
  }
}
```

`source` records the UI path and is validated by the server. It is not an
authorization mechanism. `llm_confirmed` requires a valid stored proposal whose
command and version match. The public client cannot submit `llm_tool`, which is an
internal coordinator source. Direct users can execute the same allowed operation.

A pending LLM suggestion is not an executed action. Confirmation generates a new
request ID and posts the proposed command to the same action endpoint. A state
change invalidates the proposal. The client shows the conflict rather than
silently accepting a different operation or recalculating its consequences.

## Conversation stream

The message body includes request ID, expected version, and text. The response is
`text/event-stream`, with event kinds `turn_started`, `text_delta`, `action_result`,
`proposal`, `turn_completed`, and `turn_failed`. Events carry turn ID, sequence,
and session version. `text_delta` is provisional text, not authoritative state.

The server validates authentication and version before opening the stream. After
streaming starts, failures use `turn_failed`, since HTTP status cannot be changed.
Persist the turn before the provider call. Repeated request IDs attach to/retrieve
the same turn and never run the provider again. A stored turn status and action
receipts let the UI recover if the connection closes.
The message request ID is also the turn ID, so recovery does not depend on the
browser receiving the first stream event. Only committed outputs and final text
need replay. Token-by-token deltas are provisional and need not be persisted.
Use `fetch` with a streamed response body for this authenticated POST. A native
`EventSource` cannot send the required POST body and authorization header.

Each model-selected investigation is committed before its result is sent back to
the model. If a later model call fails, that action remains committed. Mitigations
become proposals. See [LLM integration](llm.md) for bounded-loop details.

## Replay and review

Replay requires a terminal first attempt, an eligible checkpoint, and ownership.
Replay-of-replay returns `422`. Comparison returns per-path status and costs from
the shared checkpoint. Unrecovered paths have `recoveryTicks: null`.

Code Review submission is final for that submission ID. Validate each marked line
against the published diff. Save the response before releasing authored findings.
Free-text concerns are stored, not automatically graded. A later practice attempt
is a new submission and is marked as answer-informed.

## Limits and compatibility

Paginated reads use opaque cursors bound to the owner, resource, and query. Default
page size is 50, maximum 100. Reject changed-query cursor reuse. Request text and
command bounds are in the schemas and data model. Breaking wire changes require
a new API version or an explicitly reviewed pre-release contract update.
