# Gateway service boundary

Status: the production monitor HTTPS client and bounded recording controller are
implemented and tested locally. The gateway process, WebSocket route, durable recording
store, terminal proxy, and browser relay are not implemented. Follow the
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

The controller does not claim or renew the recorder lease. It also does not implement
the DynamoDB checkpoint or S3 chunk adapters. A later gateway service supplies the
current checkpoint and a sink scoped to its valid lease.

Run its local checks with:

```sh
npm run gateway:test
npm run challenge:build
npm run monitor:image:build
npm run gateway:image:test
```

The tests use temporary self-signed certificates and the real monitor HTTPS server. They
cover certificate rejection before HTTP, authentication, TLS version, connection reuse,
one safe retry, deadlines, cancellation, response bounds, sequence continuity, and the
start/read/seal lifecycle. The image test also runs the production gateway bundle in a
separate container against the monitor and Challenge containers in one task-like network
namespace. These checks do not prove Fargate networking or production certificate delivery.

Next task: connect the controller to lease-checked DynamoDB checkpoints and immutable S3
metric chunks. Terminal proxying and browser relay remain separate increments.
