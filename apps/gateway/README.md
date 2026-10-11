# Gateway service boundary

Status: the production monitor HTTPS client, private interactive and recording TCP clients, authenticated
terminal admission core, browser terminal relay, bounded recording controller, durable
recording adapters, recording-session runner, DynamoDB work source, bounded service
supervisor, and composed process image are implemented and tested locally. CDK defines
one private Fargate Gateway service, terminal and recording modules, TLS ALB, WAF,
network edges, roles, bucket, and event source, but keeps the complete path disabled by
default. No complete Gateway deployment has run.
Follow the [gateway protocol](../../docs/api.md#terminal-gateway-protocol),
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

## Terminal client

`TerminalClient` connects to the Challenge terminal server on private TCP port 7681. A
caller supplies the authoritative task IP, a positive input generation, initial terminal
dimensions, and an asynchronous output consumer. The client attaches to the existing
shell, forwards input, resize, and heartbeat operations, and reports replacement, shell
exit, or transport failure.

The client validates bounded newline-delimited JSON frames and exact generations. It
serializes operations because acknowledgements have no request identifier. It does not
retry. If the connection fails after input is offered but before acknowledgement, the
operation returns `input_uncertain`. Output delivery applies backpressure through the
consumer instead of accumulating an unbounded queue. Time spent in the output consumer
does not count against an in-flight operation timeout. The caller must invoke
`heartbeat()` at least once every 20 seconds while the terminal is otherwise idle.

The Challenge server continues this pressure through a queue of at most eight frames and
64 KiB. A full queue stops PTY reads and can block the command. A socket send that cannot
finish within one second detaches the client and makes output continuity uncertain. The
next attach reports this through `replayTruncated`. The browser relay keeps its
send path to one pending frame with an 8 KiB decoded payload, stop after a one-second
delivery failure, and send this warning to the browser. A live connection replacement
also sets the warning because output frames have no acknowledgement.

This module does not authenticate learners, consume terminal tickets, claim generations,
open a browser WebSocket, record terminal output, or alter security groups. A container
test runs the bundled client against the real Challenge terminal server and Bash PTY.

## Terminal admission and session

`DynamoTerminalAdmissionStore` reads the private session, ticket, and current terminal
input owner. One transaction confirms the same ready session and task address, consumes
the unexpired ticket, and installs the next input generation with a server-generated
connection ID. Conditional conflicts retry from current state. An uncertain response is
reconciled before the exact transaction is retried.

`GatewayTerminalSession` passes only the admitted task address and generation to
`TerminalClient`. It checks current session and input ownership with one strongly
consistent batch read before input, resize, or heartbeat. A failed check does not forward
the operation. It does not restore a ticket or generation after a failed private
connection. The browser obtains a new ticket and claims a newer generation instead.

This layer does not issue tickets, inspect an HTTP `Origin`, open a browser WebSocket,
update persistent learner heartbeats, record terminal output, or change AWS resources.

## Browser terminal relay

`GatewayBrowserTerminalRelay` attaches to a Node.js HTTP server and handles only
`GET /v1/terminal` WebSocket upgrades. It checks an exact origin allowlist before the
upgrade. The first text frame must be `auth` within five seconds. Authentication uses
`GatewayTerminalSession`, so ticket consumption, generation claims, task-address
selection, and per-operation authorization stay in one existing path.

Browser binary frames carry raw terminal input. Text frames carry validated `resize`,
`heartbeat`, and `run_proposal` messages. Proposal execution is not implemented and
returns `PROPOSAL_UNAVAILABLE`. The relay serializes private operations, pauses browser
reads during them, coalesces consecutive input frames into operations of at most 16 KiB,
and bounds already-decoded input to 64 messages or 64 KiB. A browser `heartbeat` is only
a transport liveness signal. The relay sends its own private terminal heartbeat and
WebSocket Ping after 20 seconds without another private operation, so browser timer
throttling does not disconnect an idle learner.

Callers must set total and pending-authentication connection limits. The relay returns
HTTP 503 before admission when either limit is full. These limits bound local resource
use. Deployment edge limits must also bound repeated failed admission attempts.

Terminal output returns as binary frames. Only one output frame of at most 8 KiB can wait
for browser delivery. A send that does not complete within one second closes the browser
and private terminal. The next attachment receives the terminal server's
`replayTruncated` warning. Public errors use fixed text and never include tickets,
terminal data, task addresses, or internal errors.

The runtime image now composes the relay with the recording supervisor when its complete
terminal configuration is present. CDK now defines its public ALB and private security
group path. Persistent learner heartbeat updates, dashboard traffic, proposals, command
evidence, and AWS validation remain separate work.

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

## Terminal recording source boundary

The Challenge now exposes a bounded read-only terminal source on its existing private
port. It records the original PTY stream once, independent of browser attachments.
See the [private contract](../../packages/contracts/private/terminal-recording.ts) and
[source decision](../../docs/decisions/terminal-recording-source.md).

`TerminalRecordingClient.connect({ host, expectedSource? })` attaches in recording mode
and returns `{ client, ready }`. `client.read(after, signal?)` reads one bounded page
from an explicit caller-owned cursor. `close()` releases the connection; `ended` reports
closure or a fixed error. The client checks actual wire bytes, duplicate JSON keys,
exact source schemas, and metadata and event continuity. It does not acquire terminal
input ownership, poll, reconnect, retry, or save a cursor. Overlapping reads reject
`busy`. In-flight cancellation or timeout closes the connection. Optional settings are
`port` (default 7681), `connectTimeoutMs` (3,000), and `requestTimeoutMs` (5,000).
Timeouts must be from 1 to 60,000 milliseconds. The caller controls read rate and must
read within the source's 45-second idle limit or reconnect explicitly. A complete
allowlisted idle error ends with `server_rejected` and its `serverCode`, including
`IDLE_TIMEOUT`. Unsolicited partial frames, data, and extra bytes remain invalid. See the
[client decision](../../docs/decisions/gateway-terminal-recording-client.md).

The composed Gateway collects this source with monitor measurements and monitor
recovery/outage events. Combined recording completion requires sealed terminal and monitor
cursors at the fixed lifecycle cutoff. A returned page or source exit does not prove durable or combined
completion. Root controls the source; validation is not proof of authenticity.

## Terminal page persistence

`S3TerminalChunkStore` uploads canonical, byte-preserving private JSON pages with
content-addressed keys, conditional puts, encryption, checksums, and provisional
retention. `DynamoTerminalRecordingStore` atomically writes an immutable page reference
and the exact next terminal checkpoint under the existing `RECORDING` lease. The separate
`TERMINAL_RECORDING` item saves source metadata, cursor, last committed event, and encoded
event bytes. It does not own another lease. Terminal reference keys omit generation so
a takeover cannot republish an accepted sequence range.

`DurableTerminalRecordingSink` validates and snapshots a page, uploads it, then commits
its reference and checkpoint. Empty reads commit metadata only. Cursor advancement
requires the commit. Duplicate requests and uncertain responses use the exact committed
reference; conflicting bytes cannot replace it. Failed commits can leave unreferenced
objects that expire under the provisional policy.

`TerminalRecorder` polls only from the committed cursor. Source loss at or before the
cutoff prevents completion. A strictly later event or observation, or a fully consumed
exit, proves cutoff coverage. Events at the same millisecond as the cutoff remain included.
A fully exited source closes its socket and waits for lifecycle without exceeding the
source's post-exit lifetime.

`TerminalSealer` reads one committed live page at a time, verifies its size, hash, and
canonical reference, and writes immutable sealed-retention copies. `TERMINAL_SEAL` freezes
the source checkpoint and advances only with each committed sealed page. A replacement
resumes the next range, including a partly copied final source page. Exclusion proof
must identify the next event in an exact committed live-page reference. Input generations,
monitor wire schemas, readiness, outcomes, and scores do not change. See the
[storage decision](../../docs/decisions/gateway-terminal-persistence.md) and
[combined-worker decision](../../docs/decisions/combined-recording-worker.md).

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
cutoff. Production composition also starts the terminal collector under this lease.
Monitor sealing stops measurement at the saved cutoff, but publication waits for terminal
sealing. The final transaction checks both terminal snapshots so concurrent changes cannot
bypass combined completion. A durable covered drain resumes without reopening the terminal
source. Shutdown and lease loss cancel both collectors and close their clients. The runner
does not choose an outcome, cutoff, incomplete reason, or score.

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
`createGatewayRecordingSupervisor` composes the work source, monitor and terminal clients,
runner, DynamoDB checkpoints and seal store, and S3 page adapters with the same clients. The gateway AWS
clients use two attempts and bounded connection and request times.

## Gateway process

The Gateway image starts one Node.js process. It always validates and starts the
recording supervisor. It also starts the terminal HTTP/WebSocket listener when all five
terminal settings are present. Partial terminal configuration fails startup.

| Setting                                    | Purpose                                                 |
| ------------------------------------------ | ------------------------------------------------------- |
| `GATEWAY_PORT`                             | Browser HTTP and WebSocket listener port                |
| `TERMINAL_ALLOWED_ORIGINS`                 | Comma-separated exact HTTP or HTTPS web origins         |
| `MAXIMUM_TERMINAL_CONNECTIONS`             | Total browser terminal connection cap                   |
| `MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS` | Unauthenticated connection cap, not above the total cap |
| `TERMINAL_PORT`                            | Private Challenge terminal-server port                  |

With no terminal setting, the process remains recording-only for local compatibility.
The AWS Gateway task is created only with the complete terminal configuration. When
enabled, `GET /healthz` returns a fixed readiness response and all other ordinary HTTP
paths return 404. `GET /v1/terminal` upgrades through the existing relay.
The HTTP server limits all accepted connections to the configured terminal cap plus a
fixed allowance of 32 for health checks and ordinary HTTP requests. Shutdown
force-closes incomplete HTTP requests after it stops accepting new connections.

The process generates one recorder identity, shares bounded AWS clients, converts
`SIGTERM` and `SIGINT` to cancellation, closes the listener and terminal connections,
waits for active recording runners, and then closes the clients. A fatal listener or
recording failure stops the process so ECS can replace it. Logs use only bounded event
names, session IDs, status values, and error names or codes. They do not include monitor
credentials, tickets, terminal content, allowed origins, or work records.

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
queries DynamoDB Local, isolates malformed work, serves its health route, consumes a
terminal ticket through the browser WebSocket path, attempts the private terminal
connection, and stops cleanly on `SIGTERM`. These checks do not prove Fargate networking,
ALB upgrades, production certificate delivery, IAM, or managed DynamoDB and S3 behaviour.

Next: after review and merge, deploy the disposable AWS checkpoint and validate the
complete authenticated WebSocket path through ALB, Gateway, and the Challenge terminal.
Outcome actions, command evidence and captures, debrief, playback, browser integration,
and broader AWS validation remain separate increments.
