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

## Validation boundary

DynamoDB Local tests cover successful hashed storage, ownership, all session states, an
outcome race, collision recovery, uncertain write recovery, bounded failure handling,
and validation before storage. A bundle test loads the independent Lambda output and
verifies that unauthenticated input is rejected before AWS access.

These checks do not create the Lambda, IAM role, API Gateway route, Cognito authorizer,
Gateway URL, DynamoDB TTL setting, browser WebSocket relay, or AWS deployment.
