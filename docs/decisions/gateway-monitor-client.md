# Gateway monitor client increment

Date: 7 October 2026. Scope: the production gateway module that calls one monitor
sidecar. The gateway process, recorder, browser relay, terminal, persistence, certificate
delivery, and AWS deployment remain separate.

## Choices

Use Node's HTTPS client without a web framework. The module has four typed operations
that match the monitor's fixed control API. The client and server use the same private
contract for routes, response envelopes, timestamp and cursor rules, and remote errors.
That contract is not part of public OpenAPI or a browser bundle. The client does not own
routing or run a server.

Pin the exact per-task X.509 certificate and require TLS 1.3. The task address is a
private IP, so identity comes from the exact certificate instead of public DNS. Node
validates the certificate chain and validity before the custom pin check succeeds. The
bearer secret is sent only after that handshake. Verification is never disabled.

Use one keep-alive agent with at most two active sockets per monitor and one retained idle
socket. A waiting seal therefore does not block health checks or frame reads. The gateway
attaches before learner access and avoids repeated handshakes. Calls have bounded bodies
and responses, a seven-second deadline per attempt, caller cancellation, and at most one
retry after an ambiguous transport failure. Retrying is safe because health and reads do
not mutate, while start and seal are idempotent for the same session boundary.

Validate all monitor responses at runtime. Public payloads must match the existing
browser schema, timeline frames must be monitor events, and page sequences must be
contiguous from the requested cursor. When a caller has saved a stream source, a mismatch
fails instead of combining data from two monitor processes.

The module does not advance durable cursors or poll by itself. A later recording
controller advances a cursor only after saving its frames, handles provisional live data,
and reconciles the stream at `endedAt`. This keeps transport correctness separate from
recording ownership and persistence.

## Validation boundary

Local tests use the real monitor HTTPS server and temporary certificates. They cover the
full control lifecycle, exact certificate trust, TLS 1.2 rejection, authentication,
keep-alive reuse, retry, timeout, cancellation, malformed and oversized responses, and
sequence continuity. A container test runs the production client bundle against the real
monitor and Challenge images in one task-like network namespace. These checks do not
validate Fargate networking, certificate issuance or delivery, DynamoDB leases, S3
recording, or browser delivery.
