# Gateway terminal admission increment

Status: implemented locally, ticket issuance, browser relay, and AWS validation pending
Date: 10 October 2026
Owner: Gateway contributors

## Context

The private terminal client requires a trusted task address and input generation. A
browser must not choose either value. A terminal ticket must also be consumed exactly
once, including when two gateway copies race to accept it.

## Decision

Use one private terminal-access contract for ticket and input-owner records. The gateway
hashes the raw ticket before any database lookup. It never stores or logs the raw value.

For one admission, the gateway reads the ticket, session, and current input owner with a
transactional read. It then uses one DynamoDB transaction to:

1. confirm that the same owned session is still `ready` at the same private task address;
2. delete the same unexpired ticket record; and
3. replace the input-owner record with the next generation and a server-generated
   connection ID.

The transaction prevents a consumed ticket without a generation claim. Conditional
conflicts retry from a new transactional read. An uncertain write result is reconciled
from strongly consistent state. A retry of the exact transaction uses the same DynamoDB
client token. The retry does not consume another generation.

After admission, `GatewayTerminalSession` creates the existing `TerminalClient` with the
trusted task address and generation. It checks the authoritative session and input owner
before every input, resize, or heartbeat operation. A replaced or terminal session closes
the private terminal connection. A failed terminal connection does not roll back the
generation or restore the ticket because doing so could reopen stale input authority.

## Validation boundary

DynamoDB Local tests cover single use, concurrent claims, monotonic generations, expired
and invalid state, and uncertain write responses. Unit tests cover session orchestration
and failure propagation. The existing Gateway image test uses the session layer against
the real Challenge terminal server and Bash PTY.

This increment does not issue tickets, open a browser WebSocket, update heartbeats,
record terminal output, resolve the slow-consumer policy, change network rules, or deploy
to AWS.
