# Monitor HTTPS control increment

Date: 7 October 2026. Scope: local authenticated control of the existing monitor and
sequenced delivery to a gateway-like test client. Gateway persistence, browser relay,
captures, resource statistics, certificate delivery, and AWS deployment remain separate.

## Choices

Use the built-in Node HTTPS server for four bounded JSON operations. A web framework
adds no needed behavior for this fixed internal interface. Health returns only `starting`,
`ready`, or `failed`. Every operation requires the existing per-session secret as a bearer
credential, so invalid traffic cannot consume the gateway's authenticated rate allowance.
The server and gateway import their routes, response envelopes, timestamp and cursor rules,
and remote errors from `packages/contracts/private/monitor-control.ts`. This private contract
is not part of OpenAPI and must not enter a browser bundle.

Published Challenge versions pin their monitor images, while the gateway can roll forward
separately. A new gateway must therefore accept responses from previously published monitors.
Existing operations, response shapes, health states, status meanings, and bounds remain stable.
An incompatible change requires a separately versioned contract. Error classification uses the
stable code and HTTP status, not message wording.

Use TLS 1.3 and require the client to trust the per-task certificate before it sends the
secret. Plain HTTP fails. The local test creates a temporary certificate and does not
define how production certificates are issued or delivered. The Challenge container
receives neither the secret nor the certificate key, even though it shares the network.
Production must put the certificate, private key, and secret in the encrypted per-session
S3 environment file. The private key must not appear in a `RunTask` override. The public
certificate must also be stored in the private session record for gateway verification.

Keep frames in the monitor's existing bounded memory buffer. The client reads pages of
at most 100 frames after a sequence cursor. Reads do not delete frames. A reconnect can
continue from its last saved sequence without a second measurement stream.

## Lifecycle and timing

Start is idempotent and returns the fixed measurement origin. Seal accepts the platform
lifecycle cutoff once. A retry with the same cutoff returns the same result, while a
different cutoff fails. To handle a small process-clock boundary, control accepts a
cutoff no more than five seconds ahead of the monitor clock, waits for that clock to
reach it, then passes the exact timestamp to the monitor. It reserves the cutoff before
waiting, so concurrent reads exclude later records. It never rounds, subtracts, or replaces
the lifecycle cutoff.

Frames relayed before the gateway learns the lifecycle outcome remain provisional. At an
outcome, the gateway stops live relay, discards records after `endedAt`, seals at that exact
cutoff, and replaces the live display with sealed data. A delayed outcome must remain valid,
so the monitor does not reject a cutoff only because it is in the past.

Stopping the runtime without a sealed cutoff fails the monitor. It does not invent an
outcome time. Normal session expiry must therefore supply its lifecycle cutoff through
the gateway and must not become a monitor failure. A control-server error also stops the
runtime. The sidecar must not stay alive after its control channel fails.

## Bounds and validation

The server caps bodies, headers, concurrent connections, request duration, and both
authenticated and unauthenticated request rates. It validates methods, paths, cursors,
body shape, state, and the immutable cutoff. Errors use stable public codes and contain
no private content.

The gateway attaches before learner access starts and should reuse its authenticated
connection. A root learner can still exhaust its own task network and prevent a later
gateway reconnect. The sidecar cannot reserve a new connection by bearer identity because
that identity is available only after accepting the connection. Such loss makes the
recording incomplete and the attempt a platform error with no score. Stronger availability
isolation needs a separate network boundary and is outside this increment.

Unit tests cover readiness, authentication, TLS trust, plaintext rejection, rate and
size bounds, cursor replay, idempotency, shutdown, and clock skew at sealing. The image
suite runs the Challenge, monitor, and gateway-like client as separate processes. It
also proves that a root learner on the shared network cannot use the control API without
the secret or through plaintext HTTP. Both real 60-second recovery paths pass locally.
Contract tests reject route, boundary, response, and remote-error drift. These checks do
not prove Fargate isolation, production certificate delivery, or AWS network behavior.
