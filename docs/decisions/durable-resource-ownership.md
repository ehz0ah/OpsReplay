# Durable AWS resource ownership

Status: implemented locally; retained checkpoint resources are not yet imported
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
transport.

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

The retained checkpoint resources are currently unmanaged. Select one matching table,
one bootstrap bucket, one recording bucket, and one user pool. Import exactly that set
into `OpsReplayDurableResources` before a normal deployment. Review the import mapping,
the subsequent update, and drift results. The subsequent update adds the durable bucket
transport policies.

Do not use a normal first deployment while matching retained resources exist. Do not
delete, replace, merge, or copy retained data as part of adoption. Keep every unselected
resource unchanged until its owner approves a separate disposition.

## Validation boundary

Template tests verify ownership, retention, storage controls, explicit runtime inputs,
and the execution-role permission. Local synthesis does not prove resource import,
CloudFormation drift, IAM enforcement, Cognito behavior, or S3 lifecycle timing. The
first import and later deployment require separate AWS review and approval.
