# Monitor HTTPS control increment

Date: 7 October 2026. Scope: local authenticated control of the existing monitor and
sequenced delivery to a gateway-like test client. Gateway persistence, browser relay,
captures, resource statistics, certificate delivery, and AWS deployment remain separate.

## Choices

Use the built-in Node HTTPS server for four bounded JSON operations. A web framework
adds no needed behavior for this fixed internal interface. The unauthenticated health
operation returns only `starting`, `ready`, or `failed`. Start, frame reads, and sealing
require the existing per-session secret as a bearer credential.

Use TLS 1.3 and require the client to trust the per-task certificate before it sends the
secret. Plain HTTP fails. The local test creates a temporary certificate and does not
define how production certificates are issued or delivered. The Challenge container
receives neither the secret nor the certificate key, even though it shares the network.

Keep frames in the monitor's existing bounded memory buffer. The client reads pages of
at most 100 frames after a sequence cursor. Reads do not delete frames. A reconnect can
continue from its last saved sequence without a second measurement stream.

## Lifecycle and timing

Start is idempotent and returns the fixed measurement origin. Seal accepts the platform
lifecycle cutoff once. A retry with the same cutoff returns the same result, while a
different cutoff fails. To handle a small process-clock boundary, control accepts a
cutoff no more than five seconds ahead of the monitor clock, waits for that clock to
reach it, then passes the exact timestamp to the monitor. It never rounds, subtracts,
or replaces the lifecycle cutoff.

Stopping the runtime without a sealed cutoff fails the monitor. It does not invent an
outcome time. Normal session expiry must therefore supply its lifecycle cutoff through
the gateway and must not become a monitor failure. A control-server error also stops the
runtime. The sidecar must not stay alive after its control channel fails.

## Bounds and validation

The server caps bodies, headers, concurrent connections, request duration, and both
authenticated and unauthenticated request rates. It validates methods, paths, cursors,
body shape, state, and the immutable cutoff. Errors use stable public codes and contain
no private content.

Unit tests cover readiness, authentication, TLS trust, plaintext rejection, rate and
size bounds, cursor replay, idempotency, shutdown, and clock skew at sealing. The image
suite runs the Challenge, monitor, and gateway-like client as separate processes. It
also proves that a root learner on the shared network cannot use the control API without
the secret or through plaintext HTTP. Both real 60-second recovery paths pass locally.
These checks do not prove Fargate isolation, production certificate delivery, or AWS
network behavior.
