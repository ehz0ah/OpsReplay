# API session-status increment

Status: implemented and tested locally; AWS validation pending
Date: 11 October 2026
Owner: API and Cloud contributors

## Context

The browser must read its session while provisioning and after an outcome. The v0.2 API
already defines `GET /v1/sessions/{id}` and `SessionView`. Session start persists a private
record with the learner's access grant. A read must not launch or reconcile a task,
change readiness, release a hint, or refresh learner activity.

## Decision

Use one separate Lambda action and one strongly consistent `GetItem` on
`SESSION#<id>/STATE`. Validate the API Gateway Cognito identity, route, empty body, and
UUID before reading. Missing and foreign sessions return the same `404`. Validate owned
records and the saved access grant. Its time limit must match the public view.

Reuse the session-start action's explicit nested-field projection as an ordinary shared
module. Return `SessionView` directly, not the start action's receipt response. Never
serialize the private record. Logs contain only the operation, server correlation ID,
result code, and duration. The SDK reuses clients, not learner state, uses at most two
attempts, and bounds requests and work by the invocation deadline.

Use the saved grant for this existing attempt. Do not read the current plan or content
publication status: expiry or withdrawal must not revoke the admitted session. Do not
compute an outcome from the wall clock. Lifecycle writers own those transitions.

Share the existing Regional REST API and Cognito authorizer, but keep the action's
bundle, read-only role, log group, 10-second timeout, concurrency, and method-throttling
limits separate. The role allows only session `GetItem` and scoped log writes. Disable
API caching and data tracing. Bump the immutable API deployment revision and include
both methods in its dependencies. Shared pre-Lambda errors use session-neutral text;
error codes and shapes do not change.

The existing `EnableGatewayPath=false` condition keeps the API routes absent and the
new action's reserved concurrency at zero. Reuse this switch rather than adding a
second activation mode or duplicating the API for a read-only increment. This does not
make a domain a technical requirement for session reads; it keeps the current inactive
checkpoint unit unchanged. An approved deployment change can refine that unit later.

## Validation boundary

DynamoDB Local tests cover all lifecycle and recording states, grants, ownership,
malformed records, no writes, concurrent learner reads, private-field exclusion, and
request cancellation. Template tests cover the new action's exact permissions, Cognito,
route invocation permission, deployment dependencies, throttling, and disabled state.
Run the existing start and ticket tests after moving the shared projection and fixture.

Local checks do not prove managed IAM, Cognito verification, API Gateway limits, or AWS
routing. Readiness and outcome writers, CORS, frontend integration, and deployment are
outside this increment. Domain decision tracking remains in
[issue #39](https://github.com/ehz0ah/OpsReplay/issues/39).
