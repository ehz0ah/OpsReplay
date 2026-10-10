# API terminal-ticket issuance increment

Status: implemented locally, public route and AWS validation pending
Date: 10 October 2026
Owner: API contributors

## Context

Gateway terminal admission consumes an opaque, single-use ticket, but the API did not
issue that credential. The browser must receive the raw ticket without putting it in a
URL. DynamoDB and application logs must never contain the raw value.

## Decision

Use one separate Lambda action for `POST /v1/sessions/{id}/terminal-tickets`. Trust only
the Cognito `sub` supplied by the API Gateway authorizer. Require the expected route, a
valid session ID, and no request body before any storage access.

Generate 32 random bytes and encode them as base64url. Return the raw ticket once with
the configured `wss` Gateway URL and a fixed 60-second expiry. Set
`Cache-Control: no-store`. Store only the SHA-256 ticket hash as the sort key. The ticket record contains
the owner, session ID, ISO expiry, and the same expiry as the numeric top-level
`ExpiresAt` cleanup attribute. Gateway admission still checks the ISO expiry because
DynamoDB TTL deletion is asynchronous.

Strongly read and validate the private session first. Use one DynamoDB transaction to
recheck the same owner, session ID, `ready` status, and non-null task address, then put
the absent ticket record. This prevents an outcome that races issuance from receiving a
ticket. A provisioning session returns `SESSION_NOT_READY`. A terminal session returns
`SESSION_TERMINAL`. An ownership mismatch returns `NOT_FOUND`.

## Failure and recovery

After an uncertain transaction response, use a transactional read of the session and
ticket. Accept success only when the complete expected ticket and numeric expiry exist.
Treat another record at the same hash as a collision and generate a new random value.
Retry only known transaction contention, with bounded attempts and delays. Definite IAM
and DynamoDB validation failures do not receive an application retry. Other failures
return a generic bounded error and do not expose storage details or the raw ticket.

## Deployment prerequisites

The public API Gateway method must have explicit rate and burst limits before it is
enabled. API Gateway owns the route's `429 LIMIT_EXCEEDED` response. Its GatewayResponse
mapping must return the shared `code`, `message`, and `requestId` error shape without
invoking this Lambda. The limits must be selected and checked against measured
class-sized connection and reconnect traffic. This handler does not implement a second,
independent rate counter.

Enable DynamoDB TTL on the table-wide `ExpiresAt` attribute. Reserve that top-level name
for records that are intended to expire. Ticket authorization still uses the ISO expiry
inside the validated record and does not depend on asynchronous TTL deletion.

For the session table, give this Lambda role only `dynamodb:GetItem`,
`dynamodb:ConditionCheckItem`, and `dynamodb:PutItem`. Restrict
`dynamodb:LeadingKeys` to `SESSION#*`. These actions cover the strong reads, transaction
condition check, and ticket put used by this handler.

## Validation boundary

DynamoDB Local tests cover successful hashed storage, ownership, all session states, an
outcome race, collision recovery, uncertain write recovery, bounded failure handling,
and validation before storage. A bundle test loads the independent Lambda output and
verifies that unauthenticated input is rejected before AWS access.

These checks do not create the Lambda, IAM role, API Gateway route or throttle, Cognito
authorizer, Gateway URL, DynamoDB TTL setting, browser WebSocket relay, or AWS deployment.
