# Gateway service boundary

Status: the production monitor HTTPS client is implemented and tested locally. The
gateway process, WebSocket route, persistence, terminal proxy, and browser relay are not
implemented. Follow the [gateway protocol](../../docs/api.md#terminal-gateway-protocol),
[Challenge environments](../../docs/challenges.md), and [architecture](../../docs/architecture.md).

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

The client uses one keep-alive socket per monitor. It does not poll in the background,
persist a cursor, claim recording ownership, decide readiness, relay browser messages, or
reconcile a final recording. Those belong to the later gateway recording controller.

Run its local checks with:

```sh
npm run gateway:test
```

The tests use temporary self-signed certificates and the real monitor HTTPS server. They
cover certificate rejection before HTTP, authentication, TLS version, connection reuse,
one safe retry, deadlines, cancellation, response bounds, sequence continuity, and the
start/read/seal lifecycle. They do not prove Fargate networking or production certificate
delivery.

Next task: use this client in a bounded recording controller that owns the saved monitor
cursor and final cutoff. Terminal proxying and browser relay remain separate increments.
