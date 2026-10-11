# Terminal ingress deployment increment

Status: implemented and tested locally, AWS validation pending
Date: 11 October 2026
Owner: Cloud and Gateway contributors

## Context

The Gateway process can relay a browser WebSocket to the private Challenge terminal and
supervise recording work. The existing CDK definition can run only the recording path in
an isolated subnet. It has no public listener, terminal network rule, ticket endpoint, or
health-checked load-balancer target.

The browser path must not expose the Gateway or Challenge task directly. Enabling the
listener also requires every activation control recorded by the Gateway runtime decision.

## Decision

Deploy one combined Gateway ECS service in isolated subnets. Its single process contains
the browser terminal relay and recording supervisor. An internet-facing Application Load
Balancer terminates TLS in two public subnets and forwards only `/v1/terminal` to the
private Gateway on TCP 8080. Its target group checks `GET /healthz`. The listener returns
404 for other paths. AWS WAF limits `/v1/terminal` upgrade requests to 300 per source IP
per minute. The Gateway keeps its own connection and pending-authentication limits.

The foundation gains two public subnets and two isolated workload subnets across two
Availability Zones because an internet-facing ALB requires two zones. Only the public
subnets route to the internet gateway. No NAT gateway exists. Gateway and environment
tasks receive no public address. Security groups permit only ALB to Gateway on TCP 8080,
Gateway to the Challenge terminal on TCP 7681, Gateway to the Monitor on TCP 9443, and
the existing private AWS endpoint traffic.

Use `EnableGatewayPath` as the one activation switch. When it is false, the ALB, WAF,
Gateway task and service, ticket API, and public route are absent. The ticket and
recording-work functions have zero reserved concurrency. When it is true, deployment
also requires the pinned Gateway image digest, ACM certificate ARN, exact allowed web
origins, public WSS URL, and existing Cognito user-pool ARN.

This intentionally replaces the earlier recording-only stack switch. The deployable unit
is now the one Gateway process and service that owns both internal modules. The runtime
can still start without its terminal module for isolated tests, but this stack does not
expose that as a separate deployment mode.

Deploy terminal-ticket issuance as its own Lambda action. Enable DynamoDB TTL on its
`ExpiresAt` attribute. Give the action only `GetItem`, `ConditionCheckItem`, and `PutItem`
for `SESSION#*`. Expose only `POST /v1/sessions/{id}/terminal-tickets` through a Regional
REST API with a Cognito authorizer. Limit the method to a burst of 16 and a sustained rate
of 8 requests per second. API Gateway returns the fixed public `429 LIMIT_EXCEEDED`
response before Lambda invocation when throttled.

The WAF upgrade limit, ticket burst limit, and ticket rate limit are stack parameters.
Their defaults target the first checkpoint with up to 50 concurrent learners, including
a class behind one source IP. This is a test assumption, not a production capacity claim.
The checkpoint must also test the 10-, 50-, and 100-session loads in the evaluation plan
and a simultaneous reconnect of all active terminals. On `429`, the future browser client
must use capped exponential backoff with full jitter before it requests another ticket.
It must not retry in a tight loop.

Certificate issuance, DNS records, Cognito creation, browser CORS policy, and the web
application remain separate work. Deployment inputs reference those external resources
without claiming that this increment creates them.

## Alternatives and consequences

A second recording-worker ECS service would make the diagram look modular but would
contradict the implemented process boundary and duplicate clients, lifecycle control,
and scaling. Internal modules remain separately labelled inside one Gateway service.

Putting the Gateway in a public subnet would remove the ALB-to-private-service boundary
and expose each task address. A NAT gateway is also unnecessary because private AWS
endpoints already provide the required service access.

Using API Gateway WebSockets would add another stateful transport and would not reuse the
implemented Gateway relay. The ALB preserves the current protocol and supports ordinary
WebSocket upgrades.

## Validation boundary

Template tests verify subnet routes, the absence of NAT, conditions, security-group
edges, TLS listener, health check, WAF rule, task configuration, DynamoDB TTL, action-
scoped IAM, Cognito authorization, route-specific Lambda permission, and throttling.
Local synthesis does not prove ACM, ALB WebSocket upgrades, WAF behavior, Fargate
networking, managed DynamoDB TTL, IAM, or Cognito authorization.

After review and merge, deploy the disposable checkpoint with an approved certificate,
DNS name, origin, and user pool. Test the complete authenticated WebSocket path, record
latency and isolation results, and remove all disposable resources.
