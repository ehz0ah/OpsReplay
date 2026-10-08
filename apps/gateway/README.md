# Gateway service boundary

Status: the production monitor HTTPS client, bounded recording controller, durable
recording adapters, recording-session runner, DynamoDB work source, bounded service
supervisor, and recording-only process image are implemented and tested locally. CDK
defines its private Fargate service, role, bucket, and event source, but keeps the complete
path disabled by default. No AWS deployment has run. The WebSocket route, terminal proxy,
and browser relay are not implemented. Follow the
[gateway protocol](../../docs/api.md#terminal-gateway-protocol),
[Challenge environments](../../docs/challenges.md), and
[architecture](../../docs/architecture.md).

Our own small WebSocket proxy, run as an ECS service behind the ALB. Own ticket checks,
the terminal proxy, the dashboard relay from the monitor, asciicast recording, command
events from shell markers, capture requests, heartbeats, and confirmed proposal runs.
It is the only component that connects to environment tasks, and it writes recordings
and captures to private S3.

Keep terminal input ownership separate from recording ownership. Enforce connection
generations at the terminal server and record uncertain proposal delivery without
automatic resend. The monitor connection requires authenticated TLS and task identity
verification. The reference models are not a gateway implementation.

## Monitor client

`MonitorClient` is a gateway-owned module, not a separate process. A caller supplies a
private task IP, the exact per-task certificate, and the session secret. The client pins
that certificate, requires TLS 1.3, and sends the bearer secret only through the verified
connection. It never disables certificate verification or falls back to HTTP.

The client exposes authenticated health, idempotent start, cursor-based frame reads, and
idempotent seal. It validates response media types, sizes, JSON shapes, public frame
schemas, source identity, and contiguous sequences. A saved cursor and source can resume
reading. It retries one ambiguous transport failure because all four monitor operations
are read-only or idempotent. Each attempt has a seven-second deadline and caller
cancellation stops retries.

The client uses at most two active sockets per monitor and retains one idle keep-alive
socket. This lets health checks and frame reads continue while a seal waits for its exact
cutoff. The client does not poll in the background, persist a cursor, claim recording
ownership, decide readiness, relay browser messages, or reconcile a final recording.
The recording controller owns monitor polling and reconciliation.

## Monitor recorder

`MonitorRecorder` starts one measurement stream, reads bounded pages, and sends each
page to an injected recording sink. It advances its checkpoint only after the sink
commits the page. A replacement verifies the monitor's idempotent start time, then
resumes from the saved source and cursor without creating another measurement stream.
Sink operations must be durable and idempotent.

At the session outcome, polling stops before sealing. The recorder seals the monitor at
the exact lifecycle cutoff, reads the canonical sealed stream from its first sequence,
and asks the sink to replace provisional data. This removes frames collected after the
gateway's delayed observation of the outcome. The final sample must use the same cutoff.
The recorder caps a stream at 10,000 frames.

The controller does not claim or renew the recorder lease. The recording-session runner
supplies the current checkpoint and a sink scoped to its valid lease.

## Monitor recording persistence

`DynamoMonitorRecordingStore` claims and renews a 15-second recorder lease, fences stale
gateway generations, and commits monitor cursors with immutable chunk references.
`S3MonitorChunkStore` writes versioned JSON objects with content-addressed keys,
conditional puts, S3-managed encryption, SHA-256 checksums, and the required retention
tag. Live pages expire after seven days. Sealed recordings expire after 30 days. The
recording item has no retention boundary while active. Sealing saves a conservative,
deterministic `retainUntil` before any reader can use the terminal object references.

`DurableMonitorRecordingSink` connects these adapters to `MonitorRecorder`. It uploads an
object before it advances DynamoDB state. Final sealing requires the lifecycle state to
already be `draining`, the exact saved cutoff, a current lease, and time remaining before
the drain deadline. It then atomically publishes the canonical S3 reference and changes
both recording records to `complete`.

Playback must read the recording item before it follows any object reference. At or
after `retainUntil`, the recording is expired. Before that boundary, a missing referenced
object is an integrity failure.

The existing one-day monitor-secret bucket is intentionally not used for recordings.
The [recording retention decision](../../docs/decisions/recording-retention.md) explains
the separate recording policy and deletion ownership.

## Recording runtime

`MonitorRecordingRunner` owns one claimed recording generation. It starts lease renewal
before monitor attachment, resumes the saved checkpoint, stops polling when renewal or
an append observes `draining`, and keeps renewing while the monitor seals at the saved
cutoff. Shutdown and lease loss cancel pending monitor work and close the client. The
runner does not choose an outcome, cutoff, incomplete reason, or score.

`DynamoRecordingWorkSource` queries the sparse recording-work index as an eventually
consistent hint. It uses bounded, strongly consistent batch reads to confirm base
sessions and recording leases before it returns a private task address, public monitor
certificate, or secret. Work with a live lease held by another gateway is skipped. It
retires terminal work by removing the exact index entry only while the terminal state is
unchanged. The lifecycle expiry action owns the transition for overdue provisioning
sessions. The index uses a keys-only projection, so monitor credentials do not enter it.

`MonitorRecordingSupervisor` runs a configured number of independent runners. It does
not start the same session twice in one process. It bounds retry-cooldown memory, rotates
work discovery, and cancels every runner during shutdown. Monitor, storage, and AWS
failures are isolated and reported per session. Configuration and programming errors
stop new launches and give healthy recordings up to 30 seconds to finish. The supervisor
then cancels remaining runners and stops, so a replacement can resume durable work.
`createGatewayRecordingSupervisor` composes the work source, monitor client, runner,
DynamoDB recording store, and S3 chunk store with the same clients. The gateway AWS
clients use two attempts and bounded connection and request times.

## Recording process

The recording image starts one Node.js process. It validates the table, bucket, monitor
port, and concurrency settings before it creates AWS clients. It generates a unique
recorder identity for that process, runs the supervisor, converts `SIGTERM` and `SIGINT`
to cancellation, waits for active runners, and then closes the shared clients. Logs use
only bounded event names, session IDs, status values, and error names or codes. They do
not include monitor credentials or work records.

Run its local checks with:

```sh
npm run gateway:test
npm run challenge:build
npm run monitor:image:build
npm run gateway:image:test
npm run gateway:runtime:image:build
npm run gateway:runtime:image:test
```

The tests use temporary self-signed certificates and the real monitor HTTPS server. They
cover certificate rejection before HTTP, authentication, TLS version, connection reuse,
one safe retry, deadlines, cancellation, response bounds, sequence continuity, lease
renewal, drain races, restart from a durable checkpoint, exact sealing, work discovery,
bounded concurrency, duplicate suppression, and failure isolation. DynamoDB Local also
tests the keys-only GSI and conditional work retirement. The image test runs the bundled
runner against the monitor and Challenge containers in one task-like network namespace.
The runtime image test starts the real process as a non-root, read-only container. It
queries DynamoDB Local, isolates malformed work, and stops cleanly on `SIGTERM`. These
checks do not prove Fargate networking, production certificate delivery, IAM, or managed
DynamoDB and S3 behaviour.

Next: perform the approved temporary AWS checkpoint before enabling the recording path.
That run must validate real ECS events, private port 9443 connectivity, managed DynamoDB
and S3 behavior, task replacement, and cleanup. Readiness and outcome actions, terminal
proxying, and browser relay remain separate increments.
