# Gateway monitor persistence increment

Date: 7 October 2026. Scope: durable storage adapters for one monitor recording.
The running gateway service, lifecycle outcome writer, recording bucket deployment,
browser relay, terminal recording, playback API, and AWS deployment remain separate.

## Choices

Use DynamoDB for recorder coordination and S3 for recording data. DynamoDB stores one
`RECORDING` item per session, one reference item per committed live page, the active
lease, the recorder generation, and the saved monitor checkpoint. S3 stores immutable
JSON objects under `sessions/<sessionId>/metrics/<generation>/`.

A recorder claim changes the session's public recording state from `pending` to
`recording` in the same DynamoDB transaction that creates the recording state. A claim
lasts 15 seconds by default. A different gateway can claim an expired lease and
increments the generation. Every begin, append, renewal, and seal checks the recorder
identity and generation. Append and seal also require an unexpired lease. The running
gateway supervisor will renew the lease before it expires.

Upload each S3 object before the DynamoDB transaction advances the cursor or publishes
its reference. Live page keys include the generation, source, sequence range, and SHA-256
digest. `If-None-Match: *` makes a repeated upload safe. S3 conditional conflicts get
one bounded retry. Objects use S3-managed encryption and a SHA-256 upload checksum.

Live page references are separate immutable DynamoDB items. The final canonical monitor
recording is one bounded S3 object and its reference is stored directly on the
`RECORDING` item. Sealing requires `draining`, the exact saved cutoff, a live lease, and
a time before the fixed drain deadline. One transaction publishes the canonical
reference and changes both private and public recording state to `complete`.
The lifecycle writer can instead mark `recording` or `draining` data as `incomplete`
only after the session is terminal. One transaction clears the lease and changes both
private and public recording state. The first terminal recording result wins. A retry
with the same reason is idempotent.

JSON objects carry `schemaVersion: 1`. This is an application format version. It does not
require S3 bucket versioning. Content hashes and conditional puts provide immutable
object identities. Each upload also carries the retention tag defined in the
[recording retention decision](recording-retention.md). Lifecycle rules expire all live
pages after seven days and sealed objects after 30 days.

## Failure and recovery

Conditional DynamoDB writes fence stale gateways and reject gaps or a changed monitor
source. Exact retries recover after an uncertain DynamoDB response by reading the
recording state and the immutable chunk reference. A failed S3 upload cannot advance the
cursor. A failed DynamoDB commit can leave an unreferenced S3 object, which is safe and
expires under the recording lifecycle policy. If an append loses a race with
the lifecycle transition to `draining`, it returns `recording_draining`. The future
gateway supervisor must treat this as the signal to stop polling and start sealing, not
as a recorder failure or a successful append.

Local tests cover concurrent claims, lease expiry and takeover, renewal, stale writers,
duplicate page commits, uncertain transaction responses, upload ordering, exact sealing,
incomplete transitions, terminal races, and invalid stored data. They do not prove AWS
IAM, S3, DynamoDB, or network behaviour.

## Deferred integration

The readiness action must not move a session out of `provisioning` until the private
recording item has an active lease and an initialized `startedAt` checkpoint. This keeps
the learner clock and the recording origin aligned. A first claim after `ready` remains
invalid because it would omit the start of the attempt.

The lifecycle outcome action must atomically set the recording state to `draining` with
its fixed `cutoffAt` and `drainDeadlineAt`. The lifecycle writer owns the transition to
`incomplete` when that deadline expires. Gateway and lifecycle hosts must use
synchronized UTC clocks. The deadline is an operational bound subject to that bounded
clock skew. The saved cutoff remains exact and excludes later frames from scoring.
The start-failure paths must also mark a claimed recording `incomplete` after the
session becomes terminal. This pre-ready transition uses its completion time as both
the cutoff and drain deadline. A timed-out drain preserves its original cutoff and
deadline and can use `drain_timeout` only at or after that deadline. Both lifecycle
paths must retry the transition until the private recording item and public session
view have the same terminal state.

The running gateway must claim and renew the lease, construct the recorder from the
saved checkpoint, and use these adapters. A separate private recording bucket and
least-privilege gateway role are required before deployment. The one-day monitor-secret
bucket is not a recording store.
