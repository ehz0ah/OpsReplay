# Presentation-only Pro activation

Status: implemented and verified locally. AWS verification is pending.

Owner: coding agent, requested by Lee Hao Zhe on 26 October 2026.
Scope: demo upgrade action, its contract, account discovery, and deployment controls.
The SaaS frontend and commercial price proposal are separate changes.

The prototype can demonstrate upgrading without collecting money. The UI must say
"Demo checkout" and "No payment collected". It must not collect card details or
represent the grant as a paid subscription, receipt, renewal, or invoice.

`POST /v1/demo-upgrade` accepts only the existing `MutationRequest` with its UUID
request ID. Cognito verifies the caller and the existing audience policy narrows
identity to the configured client. Only an operator-selected list of at most 20
subjects can activate access within one fixed UTC window. The endpoint is not a
public Free-to-Pro bypass. It launches no task and never opens Challenge admission.

The action uses one Lambda with a separate bundle, role, timeout, and concurrency.
Its IAM role permits only reads and conditional transactional writes in `USER#*`.
It has no ECS, Scheduler, Cognito mutation, payment, or secret access.

One DynamoDB transaction writes an owned `DEMO_UPGRADE#<requestId>` receipt and
conditionally replaces the learner's prior Free/expired plan. A matching receipt
recovers an uncertain response. Reusing it for another presentation window conflicts.
A new request ID never extends the fixed expiry. Existing effective Pro grants remain
unchanged, including shorter, longer, and indefinite grants. A replay reports the
saved action result; `GET /v1/me` supplies current access before displaying success.

The optional `Account.demoUpgradeExpiresAt` is the fixed deadline for an approved
learner. Missing or null means unavailable. It exposes no learner allowlist. The
default-off response omits this field and preserves the existing account contract.
Deploy updated browser validators before enabling demo activation. Old strict clients
reject additional fields; this is not an unrestricted backwards-compatible rollout.

`EnableDemoUpgrade` defaults to false. `DemoUpgradeOwners` and
`DemoUpgradeExpiresAt` must be set with an enabled runtime before activation. The
demo Lambda has zero concurrency unless both runtime and demo activation are enabled.
The operator validates the UTC date and unique subjects before deploying. Invalid
optional demo configuration disables activation and logs a fixed error code. It never
prevents ordinary account reads. Disabling
activation prevents new grants; it does not revoke existing grants early.

Grant expiry affects only new Pro access. Existing attempts, their admitted time
limits, hints, results, and cleanup remain covered by their saved grants. Do not
reset a learner's plan while they are using an attempt. For rehearsal cleanup, the
operator may remove only the exact demo-owned plan after confirming its expected
value and complete drain. Preserve existing manual grants and durable learner data.

Verification must cover denied identity, unknown input fields, expiry, duplicate
requests, competing writes, unknown storage errors, lost responses, corrupted records,
existing Pro preservation, and unchanged active-attempt records. Local tests do not
prove Cognito authorizer, IAM, API deployment, or CloudFront behaviour.

Local verification on 26 October 2026 passed 341 API tests, 76 web tests and 35
infrastructure tests, plus quality and contract checks. These include 16 dedicated
demo tests. Existing structural expectations were updated for the one new Lambda,
POST/OPTIONS pair and immutable API deployment V13. Property and permission checks
remain strict. Exact-diff review found and corrected optional-config isolation and
expiry error classification before the final regression run.
