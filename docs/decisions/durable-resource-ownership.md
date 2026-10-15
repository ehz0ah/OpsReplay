# Durable AWS resource ownership

Status: implemented; selected resources imported and deletion protection deployed
Date: 15 October 2026
Owner: Cloud contributors

## Context

The disposable runtime stack created the session table, Monitor bootstrap bucket,
recording bucket, and optional Cognito user pool with `Retain`. Deleting that stack kept
the data, but removed CloudFormation ownership. A later runtime deployment could create
another retained set instead of reusing the first set.

## Decision

`OpsReplayDurableResources` is the long-lived owner of:

- the session table and its stream, TTL, and `unfinished-work` index;
- the private Monitor bootstrap bucket and its one-day expiry;
- the private recording bucket and its provisional and sealed expiry rules;
- the learner Cognito user pool.

All four resources retain their data on stack deletion or replacement. The two buckets
keep S3-managed encryption, public-access blocking, and a policy that denies insecure
transport. The table and user pool use service-level deletion protection. DynamoDB
point-in-time recovery remains a separate cost and restore-policy decision.

`OpsReplaySessionStart` is disposable. It derives the table from its stream ARN and
accepts explicit bucket and user-pool identifiers. It creates no durable resource. It can still create a temporary
public Cognito client and AWS-managed login domain. These resources depend on the current
browser URLs and contain no learner accounts. External client and domain inputs remain
supported.

The disposable foundation owns the task execution role. Its identity policy grants that
role read access to the selected bootstrap bucket. The durable bucket does not retain a
principal reference to a role that disappears when the foundation is removed.

No CloudFormation export connects these stacks. Operators copy reviewed outputs to
explicit parameters. This keeps stack removal order visible and avoids an implicit
cross-lifecycle dependency. The Monitor bootstrap bucket ARN is the same explicit value
for the foundation permission and the runtime import.

## Existing-resource adoption

The selected table, bootstrap bucket, recording bucket, and user pool were imported into
`OpsReplayDurableResources` on 15 October 2026. The import changed ownership only. A
reviewed update then added the two durable bucket transport policies. Drift detection
reported `IN_SYNC` after each operation.

Do not use a normal first deployment while matching retained resources exist. Do not
delete, replace, merge, or copy retained data as part of adoption. Keep every unselected
resource unchanged until its owner approves a separate disposition.

## Validation boundary

Template tests verify ownership, retention, storage controls, explicit runtime inputs,
and the execution-role permission. The AWS adoption verified import, policy creation,
and CloudFormation drift. The protection deployment verified both live protection
settings and a subsequent zero-drift result. It did not test IAM enforcement, Cognito
authentication, S3 lifecycle timing, or a deployed runtime.
