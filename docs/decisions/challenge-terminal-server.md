# Challenge terminal server increment

Status: implemented locally, gateway and AWS validation pending
Date: 10 October 2026
Owner: Environment contributors

## Context

A Challenge requires one real root shell that survives browser or gateway reconnects.
The terminal server must reject stale input after another gateway claims the session.
It must remain usable without the browser gateway so the image can be tested first.
The current gateway does not yet proxy terminal traffic or record a terminal stream.

## Decision

Run one private TCP terminal server in the Challenge container under Supervisor. It owns
one root Bash PTY. The server accepts bounded newline-delimited JSON frames on port 7681.
The protocol supports attach, input, output, resize, heartbeat, replacement, and exit.
Terminal bytes use base64 so the JSON framing is unambiguous.

An attach installs a positive monotonic input generation. Installation, input, and resize
are serialized. A larger generation replaces the active connection. An older generation
cannot attach or send input. A complete PTY write receives an acknowledgement. A partial
or timed-out write is uncertain and must not be retried automatically.

Separate PTY reads from socket delivery with a queue of at most eight frames and 64 KiB.
When the queue is full, stop reading the PTY so the command receives backpressure. Do not
hold terminal state during a socket write. Detach a client that cannot accept one output
frame within one second. Then retain the latest 64 KiB for reconnect replay. The next
`ready` frame reports `replayTruncated: true` when replay overflowed or the failed send
made output continuity uncertain. Replacing a live connection also reports uncertain
continuity because output frames have no acknowledgement. Do not log terminal input or
output. Limit frames, decoded input, connections, dimensions, and idle time.

Keep the process stateless outside the container. A marker in the container's `/run`
directory prevents the process from opening a second shell if the server or container
restarts and loses its generation. The session lifecycle must later treat this condition
as an environment error. Refuse a replacement shell after Bash exits too. A replacement
would discard shell-local state and hide a discontinuity in the attempt. Bash ignores up
to ten consecutive Ctrl-D inputs at an empty prompt to prevent a common accidental exit.
A deliberate `exit` still ends the terminal. Detect Bash exit from the child process,
not only from PTY end-of-file, because a background process can keep the PTY slave open.
After detecting Bash exit, reject new attachments. The active handler stops processing
new operations while queued tail output and the final `exit` frame are delivered. A new
task uses a new container and starts cleanly.

This endpoint trusts the private task network. The gateway remains responsible for user
authentication, session authorization, tickets, and rate limits. This increment does not
add a browser WebSocket, terminal ticket handler, gateway proxy, shell markers, terminal
recording stream, public listener, task definition, or AWS deployment.

## Alternatives and consequences

Starting a shell per connection would lose the learner's process and working directory.
It would also let stale clients create independent shells. A terminal multiplexer adds a
second session layer but does not remove the need for generation fencing.

A WebSocket server in the Challenge image would duplicate the gateway boundary. A raw
private TCP protocol keeps browser authentication and public transport outside the learner
container. Python standard-library code avoids another runtime package in the image.

The bounded queue does not drop bytes for a client that continues to consume output. An
indefinitely blocked PTY could stop both the command and the shell, so the one-second send
limit deliberately detaches that client. The bounded replay buffer improves short
interactive reconnects. It is not sufficient for durable recording because it has no
sequence cursor or read-only consumer. The separate recording stream remains required
before end-to-end playback can be claimed.

## Validation

Image integration tests execute a real command, reconnect to the same shell, resize the
PTY, replace an older generation, reject stale and malformed frames, enforce input,
pending-output, and replay bounds, stop cleanly, keep terminal content out of logs, and
reject a replacement shell after process or container restart. A slow consumer receives
a complete multi-megabyte stream. A stalled consumer first blocks the command, then
disconnects and receives an explicit replay-truncation signal after reconnect. The
shell-exit test leaves a background process holding the PTY and verifies prompt exit
directly. It also verifies that type-ahead cannot discard tail output or the exit code.
Focused unit checks cover a non-blocking PTY read that returns `EAGAIN` and exit delivery
after queued output. Existing service, repair, trap, persistence, and isolation checks
must continue to pass.

These local tests do not prove gateway behavior, task security-group rules, Fargate
behavior, terminal recording, or AWS deployment. Validate those boundaries in later
focused increments.
