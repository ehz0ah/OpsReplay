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

JSON objects carry `schemaVersion: 1`. This is an application format version. It does not
require S3 bucket versioning. Content hashes and conditional puts provide immutable
object identities. Lifecycle cleanup can later remove unreferenced provisional objects.

## Failure and recovery

Conditional DynamoDB writes fence stale gateways and reject gaps or a changed monitor
source. Exact retries recover after an uncertain DynamoDB response by reading the
recording state and the immutable chunk reference. A failed S3 upload cannot advance the
cursor. A failed DynamoDB commit can leave an unreferenced S3 object, which is safe and
will be subject to the future recording retention rule.

Local tests cover concurrent claims, lease expiry and takeover, renewal, stale writers,
duplicate page commits, uncertain transaction responses, upload ordering, exact sealing,
and invalid stored data. They do not prove AWS IAM, S3, DynamoDB, or network behaviour.

## Deferred integration

The lifecycle outcome action must atomically set the recording state to `draining` with
its fixed `cutoffAt` and `drainDeadlineAt`. The running gateway must claim and renew the
lease, construct the recorder from the saved checkpoint, and use these adapters. A
separate private recording bucket and least-privilege gateway role are required before
deployment. The one-day monitor-secret bucket is not a recording store.
