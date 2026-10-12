# Session lifecycle and confirmed cleanup

Date: 12 October 2026. Scope: readiness, first outcome, learner liveness, deadline
repair, bounded drain, and confirmed task cleanup. This depends on the combined
recording worker. It does not deploy AWS resources or publish a debrief.

## Why

A running task is not a ready learning session. Both recorders must attach before
the learner gets access. An outcome must fix one recording cutoff. Cleanup must
not stop the task while the recorder still needs it.

## State and authority

Admission atomically creates a separate `SESSION#/LIFECYCLE` item in the existing
keys-only unfinished-work index, under the `LIFECYCLE` partition. The recorder
uses only the `RECORDING` partition. Lifecycle has no recorder lease and no
terminal input ownership. Ready attempts remain discoverable until the next PR
commits debrief, progress, finalisation, and active-lock release together.

The shared `packages/session` adapter runs in process. API and Gateway do not
invoke each other's Lambda functions. The Gateway commits the initial terminal
page before starting monitor measurement. It commits one monitor page, then saves
that measurement origin as `readyAt` under the current recorder identity, exact
recording snapshot, monitor observation, and terminal checkpoint. The saved
access grant fixes the attempt time limit.

A monitor metric observation is committed in the same DynamoDB transaction as
its immutable page reference and cursor. It contains only aggregate recovery,
source, sequence, and timestamp. The first `met` observation is retained until
an outcome is fixed. A worker restart or lifecycle sweep replays this observation
before applying loss and timeout policies. Sustained recovery cannot claim more
time than has elapsed since measurement started. The required duration cannot
change during an attempt.

The first valid outcome atomically changes the session and recording to drain,
with one cutoff and a 30-second task-coverage deadline. Later outcome requests return the saved
outcome. Owner end requests save a receipt. Repeated requests cannot apply a
second outcome. A late end or loss request uses the saved time-limit cutoff. Only
trusted replay of a committed recovery before that cutoff can resolve an attempt
after the timer is due. Expired measurement cannot publish readiness. Ending before
monitor start fences the unused recorder as incomplete without inventing a
measurement origin.

Browser heartbeat and manual input update learner liveness, with a 15-second
write interval and current terminal generation. Each connection caches only successful
liveness calls. Every operation still checks current authorization. Heartbeat writes
retry only pure transaction contention with the same request and bounded backoff.
Unknown failures still fail closed before PTY input. Private keepalive, recorder
renewal, and status polling do not update it. The heartbeat transaction requires
a ready session. Manual input records liveness before the PTY write; failure
cannot turn an accepted input into a resend.

## Reconciliation

Separate deployed actions handle session reconciliation, bounded sweep, and
owner end. Stream and ECS callbacks are discovery hints. They read current saved
state before effects. Timer callbacks carry identity only and check the saved
deadline. A separate ready timer avoids races with provisioning's immutable
creation token. Cleanup deletes the provisioning, recovery, and ready timers.

The sweep reads at most 25 lifecycle entries. It saves a bounded pagination
cursor before work, across cold starts. It checks five sessions concurrently with
an eight-second budget per session. A timeout cannot pin later invocations to the
same page. Unfinished entries remain indexed for the next pass. One session failure
does not prevent the remaining entries from being checked. Conditional writes make
repeat and concurrent reconciliation safe. The keys-only stream matches only bounded
`LIFECYCLE_HINT#` items. Ready, outcome, first recovery-met, coverage, complete, and
incomplete transactions create these hints. Cursor, lease, heartbeat, and ordinary
observation writes do not invoke reconciliation.

`MONITOR_OBSERVATION.at` owns freshness. Unchanged recovery does not rewrite lifecycle
or public state. A running task with missing recorder observations has a five-minute
recovery allowance, whether its lease is live, expired, or changing generation. This
bound starts at the last durable observation. Lease renewal cannot extend it. Expiry
uses `error/recorder_unavailable`, not `environment_exited`. The outcome transaction
checks the exact observation so recovered data prevents a stale loss decision.

After both streams cover the cutoff, the Gateway commits `RECORDING_COVERAGE` with the
exact terminal checkpoint, sealed Monitor reference, and final metric. This transaction
replaces the recording write deadline with a separate 24-hour sealing bound. The
lifecycle retains the original task deadline. The longer bound is an operational
safety limit, not a performance promise. It is below seven-day provisional retention.

The coverage receipt permits immediate task cleanup while page copying continues.
Takeover uses only saved pages and the receipt, without either task connection or a
currently valid task certificate. It resumes the existing terminal seal under the
current recorder generation. Coverage also fences later terminal checkpoint writes.
Completion validates the exact coverage and frozen terminal seal. A stopped task
or an expired task certificate after coverage does not make the recording incomplete.

Without coverage, a draining task is not stopped until recording is complete,
incomplete, the task is already stopped, or the fixed task deadline expires. A missing known task
is not STOPPED confirmation. Stop and schedule failures remain pending. Once
STOPPED is confirmed, save cleanup and remove schedules. Ready-attempt locks
remain held for once-only finalisation in the next PR. Never-ready attempts can
release only a lock that still names them and retire both discovery entries.

A bare ECS STOPPED event does not prove that the learner caused the exit. Treat
it as a platform error. Do not infer blame from containers that ECS stopped as a
consequence. Learner-caused challenge exit classification needs trusted process
exit evidence; it is not inferred by this increment.

## Deployment and rollback

CDK defines separate bundles, roles, timeouts, and disabled concurrency for the
three new actions. The stream mapping, minute sweep, and STOPPED rule remain
disabled. The owner route uses Cognito and capped throttling. Reconciliation reuses the
existing saved-argument provisioner and repairs missed recording-work publication.
Its roles can launch only admitted task families and can write/read tags only on
private bootstrap files. They cannot read bootstrap bodies or recording objects.
Owner end has no ECS or S3 access. No action invokes another Lambda. The Gateway
keeps its existing session-only DynamoDB permissions.

Keep admission disabled until debrief/finalisation and an approved AWS checkpoint
are ready. This PR intentionally cannot release a ready attempt's lock. A rollback
must stop new admissions, retain state and recordings, and complete active drains
before removing the new worker. Do not restore monitor-only completion for
combined sessions.

## Verification

Tests use DynamoDB Local for atomicity, races, lost responses, readiness proofs,
recovery replay, duplicate end receipts, heartbeat generations and conflict retries,
coverage takeover, task cleanup during sealing, deadline expiry, and lock retention.
A virtual-delay test copies 3,000 source pages through an interrupted pass. It checks
that work exceeds the short task drain and resumes from the saved cursor. The production-composition test uses real monitor HTTPS,
synthetic terminal TCP, DynamoDB Local, and injected S3 storage. Unit and CDK
tests cover bounded handlers, pagination, timer repair, owner projection, roles,
and disabled triggers. Existing API, Gateway, contract, infrastructure, Challenge,
and runtime-image checks remain required. These checks do not prove managed AWS
permissions, timing, or recovery behaviour.
