# Checkpoint runtime activation

Status: implemented locally, AWS validation pending
Date: 13 October 2026
Owner: Cloud and backend contributors

## Context

The application stack has the Gateway, public owner actions, recording-work publisher,
and lifecycle actions, but the earlier activation switch enabled only part of this path.
Reconciliation, sweep, STOPPED events, owner end, and result reads still had zero
concurrency or disabled triggers. Enabling admission in that state could create sessions
that the stack could not finish.

Runtime preparation and learner admission are also different operator decisions. The
runtime must be testable before new sessions are accepted, and an operator must be able
to stop new attempts without disabling cleanup for sessions that already exist.

## Decision

Keep `EnableGatewayPath` as the compatible complete-runtime switch. When true, it enables
the Gateway service, recording-work publication, terminal tickets, session status,
owner end, debrief, timeline, playback, ReconcileSession, SweepSessions, the filtered
lifecycle stream, the minute sweep, and the RUNNING and STOPPED task-state paths. Each
Lambda keeps a separate bundle, role, timeout, and bounded concurrency.

Add `EnableSessionAdmission`, default `false`. CloudFormation rejects admission when
`EnableGatewayPath` is false. Admission controls only StartSession reserved concurrency.
The authenticated route can remain in the runtime API while its Lambda is hard-throttled
at zero. Closing admission therefore does not remove or throttle any action needed by an
existing session.

Keep ExpireProvisioning at zero. Current start schedules target ReconcileSession, which
owns provisioning recovery and the later lifecycle. Enabling the older action would add
a second cleanup implementation to the same session.

The learner user pool has a separate durable owner. The explicit identity-mode parameter
controls only the disposable checkpoint app client and login domain. The default external
mode creates neither resource.

Activation is manual and staged:

1. deploy the complete runtime with admission closed;
2. verify the pinned images, private task, Gateway, identity, network, triggers, and
   quotas;
3. publish the reviewed content release;
4. open admission for the approved test window;
5. close admission first, then drain and verify all existing work;
6. disable and remove only resources whose retention and ownership were reviewed.

The [checkpoint runbook](../runbooks/aws-checkpoint-activation.md) owns the exact gates.
No workflow deploys or activates this stack automatically.

## Consequences and validation boundary

The two-switch matrix prevents a half-enabled runtime and provides a reversible stop for
new starts. It does not prove that the school account has enough Lambda or Fargate quota,
that an ACM certificate matches DNS, that images are safe, or that managed event delivery
works. Local tests resolve all three activation states and assert every required trigger
and action. A separately approved AWS window must validate the managed-service behavior
and teardown.

Reserved concurrency zero is an admission gate for StartSession. It is not a drain or
shutdown mechanism. Existing-session actions stay enabled until recording, cleanup,
finalisation, and retained-resource checks are complete.
