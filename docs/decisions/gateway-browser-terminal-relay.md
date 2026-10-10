# Gateway browser terminal relay increment

Status: implemented and tested locally, process integration and AWS validation pending
Date: 11 October 2026
Owner: Gateway contributors

## Context

The terminal ticket API, atomic Gateway admission, and private Challenge terminal client
exist as separate local-tested components. A browser cannot use them directly. It needs
an HTTP upgrade boundary that validates the web application origin, authenticates the
first message, and relays terminal bytes without adding an unbounded buffer.

The existing Gateway image runs only the recording process. Combining that process with
an HTTP server and changing its AWS service are separate runtime and deployment changes.

## Decision

Add a reusable WebSocket relay that attaches to a Node.js HTTP server. It accepts only
`GET /v1/terminal` with no query and an exact configured `http` or `https` origin. It
disables WebSocket compression and limits each decoded browser message to 16 KiB.

The first message must be a valid `auth` text frame within five seconds. No other message
is accepted while admission is in progress. Successful authentication uses
`GatewayTerminalSession.open()`. This atomically consumes the one-use ticket, claims a
new input generation, selects the authoritative private task address, and attaches the
existing terminal client. The browser receives `ready` only after private attachment.
`ready.replayTruncated` preserves the Challenge server's continuity warning.

Binary browser frames are raw terminal input. Valid `resize` text frames use the session
operation path. Browser `heartbeat` frames are transport liveness signals and do not
control the private terminal keep-alive. Operations remain ordered. The relay pauses
socket reads while it processes them and keeps at most 64 queued browser messages or
64 KiB if more frames were already decoded from one network read. Consecutive binary
frames are coalesced into input operations of at most 16 KiB. This absorbs normal
keystroke and mouse-event bursts without removing the byte or message backstop. The
relay returns `RATE_LIMITED` and closes when either bound is exceeded. `run_proposal`
returns `PROPOSAL_UNAVAILABLE` without closing because proposal delivery is not part of
this increment.

The gateway owns idle keep-alive. After 20 seconds without a private operation, it sends
one authorized terminal heartbeat and one WebSocket Ping through the same ordered queues.
This does not depend on browser timers, which can be throttled in a background tab.

The caller must configure a total connection limit and a smaller or equal pending-
authentication limit. The relay rejects a valid upgrade with HTTP 503 before admission
when either limit is full. Rejected raw sockets have an error handler and are destroyed
after the response is flushed. Edge rate limiting remains necessary to bound sequential
failed admission attempts.

Each terminal output frame is at most 8 KiB. The relay permits one such frame to await
browser delivery. If its WebSocket send does not complete within one second, the relay
closes both directions. The private terminal server then marks output continuity as
uncertain, and the next connection receives `replayTruncated: true`. Input is never
retried after an uncertain private result.

Public errors use fixed messages. They do not include tickets, terminal content, task
addresses, stored records, or internal error text. Closing the browser cancels admission
or pending operations and closes the private terminal client.

## Alternatives and consequences

Putting the ticket in the WebSocket URL would expose it to access logs and browser
history. The ticket stays in the first text frame.

Accepting all origins would allow another site to open a credentialed terminal from a
learner's browser. The exact origin allowlist is required before upgrade.

An unbounded input or output queue could exhaust the Gateway or hide a stalled browser.
The fixed queue and send limits provide a small, testable memory boundary. A slow or
excessive client must reconnect with a new ticket.

## Validation boundary

Local tests use a real HTTP server and WebSocket client. They cover origin and path
rejection, reset rejected sockets, total and pending-authentication caps, the
authentication deadline, public error mapping, direct input, resize, heartbeat, proposal
rejection, binary output, replacement, uncertain input, and cleanup. Controlled peer
tests cover idle keep-alive, input coalescing, input queue bounds, output size, and send
deadlines.

This increment does not start a Gateway HTTP process, change the recording process,
package a new runtime image, update security groups or load balancers, or deploy to AWS.
It does not implement dashboard relay, persistent learner heartbeat updates, proposals,
or terminal recording.
