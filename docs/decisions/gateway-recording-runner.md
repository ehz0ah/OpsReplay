# ADR: gateway recording runner

Status: implemented locally, AWS validation pending
Date: 8 October 2026
Owner: Hao Zhe

## Context

The monitor client, recording controller, DynamoDB lease store, S3 chunk store, and
durable sink were independent modules. Tests could call them directly, but no runtime
component coordinated a recording from claim through final sealing. A session can also
enter `draining` while the monitor has no new frames, so append failures alone cannot
detect every outcome.

The documented session work index, task address, and per-task public monitor certificate
are not implemented. Adding guessed fields or an alternate local session system would
create a second lifecycle contract.

## Decision

Add a one-use `MonitorRecordingRunner` for one session and generation. It claims the
recorder lease, starts renewal before monitor attachment, creates the durable sink,
begins or resumes the monitor checkpoint, records pages, and seals at the cutoff already
stored by the lifecycle writer.

Lease renewal continues during monitor start, polling, and final sealing. A renewal that
observes `draining` cancels polling even when the monitor has no frames. An append that
loses the race with the drain transition performs an immediate renewal to obtain the
saved cutoff. Lease loss cancels current work and returns ownership to discovery after
expiry. Shutdown cancels pending work and closes the monitor client. The runner never
selects an outcome, cutoff, incomplete reason, or score.

The monitor's idempotent start operation continues to return its original start time
after sealing. This lets a replacement runner verify the saved stream identity and retry
a seal whose monitor response or durable commit was lost.

Add a sequential `MonitorRecordingWorker` around the runner. It receives validated
private work from an injected `MonitorRecordingWorkSource`, constructs the production
TLS client, and applies bounded backoff after claim conflicts or lease loss. Processing
one session at a time is the first bounded runtime. Increase local concurrency only after
measurement.

Do not implement a DynamoDB work-source adapter or executable process until lifecycle
code owns the required task address, certificate, and work-index writes. This preserves
one session schema and avoids a temporary discovery mechanism.

## Failure and recovery

All durable writes remain generation-fenced. A stale runner cannot append or seal after
lease loss. A replacement runner receives the saved checkpoint from its new claim and
continues from that cursor. The runner does not mark a recording incomplete because that
decision depends on the lifecycle outcome and drain deadline.

Unexpected dependency failures remain visible to the worker host. They are not converted
to successful completion. A stopped worker leaves no in-memory state that another copy
needs. Its lease expires and permits takeover.

## Validation

Unit tests cover start, checkpoint resume, idle-stream draining, append and drain races,
renewal during a slow seal, claim conflicts, lease loss, cancellation, one-use guards,
and client closure. A DynamoDB Local integration test covers claim, append, renewal,
canonical sealing, and the public recording transition through the runner. The container
test runs the bundled runner against the real monitor HTTPS service after a recorded
stream is sealed.

These tests do not prove the future session-work adapter, production certificate
delivery, IAM, Fargate networking, or deployed DynamoDB and S3 behaviour.
