# Gateway terminal client increment

Status: implemented locally, browser relay and AWS validation pending
Date: 10 October 2026
Owner: Gateway contributors

## Context

The Challenge image exposes one private terminal server on TCP port 7681. The gateway
needs a bounded client for that protocol before it can relay an authenticated browser
connection. Calling Docker Exec or ECS Exec would make an operator interface part of the
learner data path and would not preserve the protocol's input-generation fence.

## Decision

Use one long-lived Node TCP client per interactive attachment. A caller supplies a
literal task IP, terminal dimensions, a positive input generation, and an asynchronous
output consumer. The client performs the versioned attach handshake and exposes input,
resize, heartbeat, close, and terminal-end operations. It does not authenticate a user,
claim a generation, or run a public server.

Validate every server frame, generation, field set, base64 payload, and size before use.
Process output through the supplied asynchronous consumer so a slow downstream consumer
stops Gateway socket reads instead of creating an unbounded application queue. Do not
count time spent in that consumer against an in-flight operation timeout. The caller
must send a heartbeat at least once every 20 seconds while the connection is otherwise
idle, which stays below the terminal server's 45-second idle limit.

This is not end-to-end PTY backpressure. The terminal server stops a blocked socket send
after one second, detaches the client, and keeps only the latest 64 KiB for reconnect
replay. It does not pause the command. Before browser relay is implemented, define
whether the server will apply PTY backpressure or the relay will use another bounded,
user-visible slow-consumer policy. Track that decision in
[issue #31](https://github.com/ehz0ah/OpsReplay/issues/31).

Serialize input, resize, and heartbeat requests. Their acknowledgements contain a
generation but no request identifier, so more than one outstanding request of the same
kind would be ambiguous. Do not reconnect or retry automatically. If input was offered
to the socket but its acknowledgement is lost, report `input_uncertain`. A later layer
must tell the learner to inspect the terminal before deciding what to do next.

The connection uses the private task network without TLS, as defined by the Challenge
terminal-server decision. The future gateway session layer must authenticate the learner,
consume a ticket, claim the generation, and select the authoritative task address before
constructing this client. The task security group must restrict port 7681 to the gateway.

## Validation boundary

Unit tests use controlled TCP peers for fragmented frames, output interleaving, operation
ordering, malformed and oversized responses, cancellation, replacement, and lost input
acknowledgements. A container test runs the bundled Node client against the real Challenge
terminal server and Bash PTY. It verifies preserved shell state, generation replacement,
resize, heartbeat, and shell exit.

These checks do not implement or validate terminal tickets, browser WebSockets, durable
terminal recording, shell markers, security-group rules, Fargate networking, or AWS
deployment.
