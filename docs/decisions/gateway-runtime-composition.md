# Gateway runtime composition increment

Status: implemented and tested locally, public routing and AWS validation pending
Date: 11 October 2026
Owner: Gateway contributors

## Context

The Gateway browser relay, terminal admission store, private terminal client, and
recording supervisor exist as tested components. The runtime image starts only the
recording supervisor, so no running Gateway process accepts browser WebSocket upgrades.

The existing inactive AWS recording definition has no public listener or known web
origin. Runtime composition must not silently expose it or weaken origin validation.

## Decision

Use one Gateway process for the recording supervisor and browser terminal listener.
Both use the same bounded DynamoDB client. Recording also uses the same S3 client as
before. The listener attaches `GatewayBrowserTerminalRelay` to a Node.js HTTP server and
uses `DynamoTerminalAdmissionStore` for the existing ticket and input-generation checks.

Terminal service is enabled only when all five settings are present:

- `GATEWAY_PORT`
- `TERMINAL_ALLOWED_ORIGINS`
- `MAXIMUM_TERMINAL_CONNECTIONS`
- `MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS`
- `TERMINAL_PORT`

Partial or invalid configuration stops startup. Origins are a bounded comma-separated
list of exact HTTP or HTTPS origins. Connection counts and ports have fixed ranges. The
pending-authentication limit cannot exceed the total connection limit. When no terminal
setting is present, the process keeps its existing recording-only behavior. This keeps
the inactive AWS recording definition valid until the public-route increment supplies
the complete terminal configuration.

When enabled, the HTTP server binds inside the container and serves only `GET /healthz`
and the relay's `GET /v1/terminal` upgrade. Other HTTP requests return 404. The health
route returns ready only while the listener accepts traffic. Request headers and HTTP
timeouts are bounded. The listener caps all accepted connections at the configured
terminal connection limit plus a fixed allowance of 32 for health checks and ordinary
HTTP requests.

`SIGTERM` and `SIGINT` cancel recording work, stop accepting new connections, close
browser and private terminal connections, and close the shared AWS clients. A listener
or recording-supervisor failure stops the complete process. ECS can then replace it,
and durable recording leases allow recording work to resume. Shutdown force-closes any
incomplete plain HTTP requests so they cannot block process exit.

## AWS activation prerequisites

Before the terminal settings are added to the task definition, the public-route
increment must:

- grant the Gateway task role `dynamodb:DeleteItem` for `SESSION#*` keys;
- allow the load balancer to reach `GATEWAY_PORT` and the Gateway to reach environment
  tasks on `TERMINAL_PORT`;
- add edge rate limiting for `/v1/terminal`;
- deploy the terminal-ticket route with its throttle, DynamoDB TTL, and narrow role; and
- configure the ECS or target-group health check to use `/healthz`.

These are activation requirements. This increment does not make the AWS changes.

## Alternatives and consequences

Starting a second process for the browser path would duplicate configuration, clients,
logging, and lifecycle control inside one Gateway task. One process keeps one clear
service boundary.

Starting a listener without an allowed origin would either reject every browser or
require an unsafe wildcard. Explicit all-or-none terminal configuration avoids both.

The combined process means a fatal listener failure also restarts recording work. This
is acceptable for the first Gateway service because recordings are durable and fenced.
The runtime closes both paths before it exits. A server `error` after startup remains
fatal because it does not prove that the listener can still accept learner connections.
The outer connection cap reduces the risk of file-descriptor exhaustion before this
fail-safe applies.

## Validation boundary

Unit tests cover configuration bounds, partial configuration, the health and 404 routes,
recording-only compatibility, listener bind failure, listener runtime failure,
recording failure, cancellation, and cleanup. The runtime-image test starts the real
non-root read-only image, reaches its health route, consumes a real DynamoDB Local ticket
through the WebSocket path, attempts the private terminal connection, and verifies clean
termination.

The existing container integration separately proves the terminal client against the
real Challenge PTY. These checks do not prove ALB WebSocket upgrades, security groups,
Fargate networking, managed DynamoDB, IAM, or public origin configuration. Public
routing and AWS validation remain separate work.
