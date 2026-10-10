# Terminal output backpressure

Status: implemented locally, browser relay and AWS validation pending
Date: 10 October 2026
Owner: Gateway and Environment contributors

## Context

The Gateway terminal client waits for its output consumer before it reads another
Challenge frame. TCP then carries downstream pressure to the Challenge server. The
terminal server previously wrote PTY output to that socket from the PTY reader while
holding terminal state. A blocked send stopped after one second and detached the client,
but control operations waited on the same state lock and the reconnect signal did not
cover uncertain socket delivery.

## Decision

Separate PTY reading from socket delivery with one bounded queue. The queue holds at
most eight frames and 64 KiB. Each frame contains at most 8 KiB of terminal output. When
the queue is full, the server stops reading the PTY. The PTY buffer then applies pressure
to the command instead of allowing an unbounded application queue.

Do not hold terminal state while waiting for a socket write. A replacement generation
can install its connection while the previous output write is blocked. The server sends
`REPLACED` to the old connection only when that socket can accept the error immediately;
it always closes the old connection.

An output frame has a one-second send limit. If the active connection cannot accept the
frame, close it, mark output continuity as uncertain, and drain current and later PTY
output into the existing 64 KiB replay buffer. The next successful `ready` frame sets
`replayTruncated: true`. This signal means that the resumed view can have a gap because
the replay buffer overflowed, a stalled send failed, or a live connection was replaced
without per-frame acknowledgements. It must remain visible to the learner. A successful
attach clears the signal after delivering the warning and any replay.

After Bash exits, reject new attachments. The active handler stops processing new
operations until queued tail output and the final `exit` frame are delivered. This keeps
type-ahead, resize, or heartbeat frames from closing the connection before the exit.

The Gateway keeps no extra output queue. Its asynchronous output consumer must complete
only after the next relay has accepted the frame into its own bounded send path. The
future browser relay must allow at most one terminal frame with an 8 KiB decoded payload
to await WebSocket delivery. It must close the private terminal client if that delivery
does not complete within one second, and it must show the replay-truncation warning after
reconnect. This change does not implement that relay.

## Alternatives and consequences

An unbounded queue can exhaust the Challenge container. Dropping or coalescing terminal
bytes can corrupt command output. Blocking the PTY reader directly inside a socket write
would also delay connection replacement and other terminal state operations. The bounded
queue preserves output for a progressing client, bounds memory, and keeps control state
responsive. A client that stops consuming is detached so that one dead connection cannot
stall the shell forever.

This protocol does not acknowledge each output frame. It therefore reports uncertain
continuity after a stalled send instead of claiming exact delivery. Durable terminal
recording remains a separate data path.

## Validation boundary

The Challenge image test uses a real Bash PTY. A slow client reads a multi-megabyte output
stream and verifies every byte without disconnecting. A stalled client verifies that the
command first blocks, the one-second send limit then detaches the client, and reconnect
reports truncated replay with the final output marker. Unit checks cover the queue bounds
and the uncertain-delivery signal. Exit checks verify that type-ahead cannot discard
queued tail output or the final exit code.

These local tests do not validate a browser WebSocket, Fargate networking, or AWS
deployment.
