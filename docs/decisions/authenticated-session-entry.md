# Authenticated session entry

Status: implemented and tested locally, AWS validation pending
Date: 13 October 2026
Owner: Cloud and API contributors

## Decision

Expose the existing StartSession action as `POST /v1/sessions` on the existing Regional
REST API. Keep it as its own Lambda, role, bundle, permission, timeout, and method limit.
Its reserved concurrency remains zero until the complete runtime is activated.

Use a Cognito user-pool authorizer. A deployment can supply an existing pool, public app
client, and AWS-managed login hostname, or explicitly create checkpoint-owned Cognito
resources. The managed client has no secret and enables only the authorization-code OAuth
flow. The browser must use PKCE with `code_challenge_method=S256`; no implicit flow,
identity pool, browser AWS credentials, social provider, or custom authentication service
is added.

The authorizer verifies the user pool. Each API Lambda then accepts only an ID token whose
`aud` equals the configured public app-client ID and derives ownership only from its
verified `sub`. An access token or a token for another app client cannot supply ownership.

Configure one exact browser origin. Lambda proxy responses and API Gateway errors return
that fixed `Access-Control-Allow-Origin` value. Unauthenticated mock `OPTIONS` methods
return exact methods and the `Authorization,Content-Type` header list. Wildcards, reflected
origins, credentialed CORS, and an arbitrary multi-origin allowlist are excluded.

## Reason

The backend already has action-scoped handlers and owner checks, but the StartSession
handler had no public route. This change connects the existing contract without adding a
custom identity service or combining actions in one Lambda. A fixed origin fits the first
checkpoint and avoids pretending that REST API GatewayResponse templates can safely
select from an arbitrary origin list.

## Limits

CloudFormation can define the managed client but cannot prove that a supplied external
client uses the same OAuth settings. API Gateway and Cognito behaviour, PKCE browser
integration, token expiry, CORS, throttling, and managed login still require the approved
AWS checkpoint. No frontend login page is included. Merge does not enable session start or
deploy a stack.
