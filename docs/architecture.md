# Architecture

Status: the backend path for the
[reference Challenge](../content/challenges/wrong-upstream-port/README.md) is implemented.
It includes authenticated session entry, Fargate launch and cleanup, the Monitor,
CloudFront terminal ingress, the Gateway, durable recording, hints, deterministic
debrief, timeline, and playback. An operator-seeded terminal-to-result AWS checkpoint
passed on 15 October 2026. It did not exercise Cognito, API Gateway, or session start.
Its disposable resources were removed, and every runtime gate remains default-off.
The web application, catalogue and account bootstrap APIs, additional Challenges, and
hosted deployment are not implemented. See the
[checkpoint report](checkpoints/2026-10-15-terminal.md).

This document owns the service layout. The domain contracts own detailed behaviour, as
defined in the [decision register](decisions/README.md). Diagrams are views of these
contracts, not independent requirements. Record the revision and proposal status when
sharing one. A detailed drawing does not make an open choice settled.

## Components

All three modes share one web application, account system, and progress store.

```mermaid
flowchart LR
  UI[Browser: app, terminal, dashboard, chat] -->|REST| API[API Lambda handlers]
  UI -->|WebSocket| RELAY
  API --> DB[(DynamoDB)]
  API --> S3[(Private S3)]
  API --> ECS[ECS RunTask and StopTask]
  API --> SCH[EventBridge Scheduler]
  API --> LLM[External LLM provider]
  subgraph GW[Gateway ECS service: one task and process]
    RELAY[Terminal relay and admission]
    REC[Recording supervisor]
  end
  RELAY --> DB
  RELAY --> ENV
  REC --> DB
  REC --> S3
  REC --> ENV
  subgraph ENV[Environment task per attempt]
    CH[challenge container]
    MON[monitor container]
  end
  DB -. stream .-> FIN[Finaliser]
  FIN --> ECS
```

| Component           | Responsibility                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app             | Static pages, catalogue, Learn, Code Review, Challenge workspace, debrief, playback                                                                   |
| API handlers        | Identity, plans, catalogue, sessions, tickets, hints, timeline, debrief, playback, reviews, LLM turns                                                 |
| Lifecycle handlers  | Readiness from ECS task events, time limits from Scheduler, heartbeat sweep, reconciliation                                                           |
| Finaliser           | Waits for a bounded recording drain, stops the task, releases the lock, derives the debrief and score from sealed data, updates progress              |
| Gateway service     | Ticket checks, terminal proxy, dashboard stream, session recording across browser disconnects, final drain, command events, proposal runs, heartbeats |
| Challenge container | Service stack, planted fault, supervisor, terminal server                                                                                             |
| Monitor container   | Traffic, metrics, validators, health probes, captures                                                                                                 |

The API handlers are separate Lambda functions, one per action, that share code modules
and contracts. Each action has its own bundle, execution role, and limits. Functions do
not invoke other Lambda functions. Ordinary calls to shared modules are allowed.
Learner state stays in DynamoDB, not warm process memory. LLM
turns run in their own function so they have separate concurrency and timeout limits.
They are not separate microservices. The gateway is the only component that talks to
environment tasks. Lambda handlers stay outside the VPC.

## Proposed AWS deployment

The deployment uses CDK with TypeScript, one workload Region, and a CloudFront-scope WAF
in `us-east-1`. The permanent workload Region remains open. The MVP uses the default
CloudFront hostname and does not require a custom domain.

```mermaid
flowchart TB
  Browser -. DNS lookup and answer .-> R53[Route 53]
  Browser -->|GET app| CF[CloudFront]
  CF --> Web[Frontend S3: static app and free Learn]
  Browser -->|Sign in| Cognito
  Browser -->|Authenticated REST and SSE| APIGW[API Gateway REST API]
  APIGW --> Lambda[Lambda: API and LLM]
  Lambda --> DDB[DynamoDB: sessions and events]
  Lambda --> Private[Private S3: content and recordings]
  Lambda --> Provider[External LLM API]
  Browser -->|Terminal WebSocket| TCF[CloudFront terminal distribution]
  TCF -->|VPC origin, HTTP| ALB[Internal Application Load Balancer]
  ALB --> Relay
  subgraph Cluster[ECS cluster on Fargate]
    subgraph Gateway[Gateway service: one task and process]
      Relay[Terminal relay and admission]
      Recorder[Recording supervisor]
    end
    Tasks[Fargate environment tasks]
  end
  Relay -->|Terminal proxy| Tasks
  Recorder -->|Monitor recording| Tasks
  Lambda -. telemetry .-> CW[CloudWatch]
  Relay -. telemetry .-> CW
  Recorder -. telemetry .-> CW
```

These figures show component relationships, not every request and response. Route 53
resolves names. Application traffic goes directly to the resolved entry point.

**Entry and web tier.** The current MVP terminal definition uses the default CloudFront
hostname and certificate. It needs no Route 53 registration. CloudFront reaches an
internal ALB through a VPC origin. Its separate edge WAF is owned in `us-east-1`.
The [ingress decision](decisions/cloudfront-terminal-ingress.md) records the default
certificate policy and private HTTP transport limits. Static web and free Learn hosting
through CloudFront and S3 remain planned. The Regional REST API and Cognito retain
their AWS-managed hostnames. Custom domain names remain a separate choice. Cognito
identifies users. The backend checks session ownership and plan entitlement on every
request.

**API and state.** A Regional API Gateway REST API routes requests to stateless Lambda
handlers. The LLM route streams responses, which REST APIs support. The cheaper HTTP API
lacks streaming and has a 30-second integration limit. Lambda remains billed while it
waits for the model, even after the client disconnects, so provider deadlines, token
limits, and a separate concurrency budget bound AI use. DynamoDB stores progress,
sessions, per-command timeline events, review submissions, and conversation history,
all read by key. Terminal recordings and log captures exceed DynamoDB's item size, so
they go to private S3. Session start and end use conditional writes keyed by request ID,
so a retry cannot launch a second task or record a result twice. See the
[data model](data-model.md).

**Challenge environments.** To start a Challenge, a handler calls ECS `RunTask` with the
Challenge's task definition, pinned to ECR image digests, and later stores the task's
private address in DynamoDB. An EventBridge Scheduler job stops the task at the time
limit, and a missed heartbeat stops abandoned tasks sooner. Scheduler fires with
one-minute precision, which the time limit tolerates. Completed one-time schedules still
count against the Scheduler quota, so the finaliser deletes them. See
[Challenge environments](challenges.md).

Provisioning creates two self-deleting callbacks before launch: timeout at three
minutes and recovery at eight minutes. The latter is created first. This covers the
ECS discovery window independently of Lambda's two asynchronous retries. The monitor
secret is injected from a private, encrypted S3 environment file through the execution
role. `RunTask` contains only the file ARN. See the
[provisioning review decision](decisions/provisioning-review.md).

**Gateway service.** Terminal and dashboard traffic uses WebSockets. The gateway is our
own small WebSocket proxy, run as one ECS service in the same Fargate cluster as the
environment tasks. One process contains the terminal relay and recording supervisor.
These are internal modules, not separate ECS services. The relay validates a short-lived
ticket, looks up the learner's task address, and proxies the terminal. The recording
supervisor saves terminal and monitor data outside the learner's reach. CloudFront
terminates viewer TLS. The internal HTTP ALB spreads connections across
Gateway copies. It does not balance environment tasks. The ALB idle timeout stays above
the heartbeat interval. See the [gateway protocol](api.md#terminal-gateway-protocol).

**Warm pool.** A small pool of started, unassigned tasks can hide start-up time before a
scheduled class. A session claims a pooled task through a conditional write. Scores and
counters count from `readyAt`, so time a task spends waiting in the pool is excluded.
Pooled tasks cost money while idle and expire after a bounded wait. The pool is optional
and follows the first milestone.

## Network and isolation

| Placement       | Resources         | Inbound                                             | Outbound                                       |
| --------------- | ----------------- | --------------------------------------------------- | ---------------------------------------------- |
| Private subnets | Internal ALB      | HTTP from the CloudFront origin-facing prefix list  | Gateway service                                |
| Private subnets | Gateway service   | ALB only                                            | Environment tasks, VPC endpoints               |
| Private subnets | Environment tasks | Gateway service only, on terminal and monitor ports | VPC endpoints for image pulls and monitor logs |

Each Fargate task has its own isolation boundary and shares no kernel, CPU, memory, or
network interface with other tasks. Environment tasks have no internet route and no task
IAM role, so root shells expose no AWS credentials. CPU, memory, and time caps limit
misuse. Containers inside one task share a network namespace. A sidecar and a plaintext
secret do not protect monitor traffic from a root shell. Require authenticated TLS with
task identity verification, remove `NET_RAW` and other unnecessary capabilities, and do
not share the monitor's process namespace or secret storage. See the
[monitor controls](challenges.md#monitor). Validate these controls on Fargate before
hosted access. They protect the measurement process, not the truth of learner-written
logs or configuration.

Private subnets use VPC endpoints instead of a NAT gateway: ECR API and Docker registry
endpoints, an S3 gateway endpoint for image layers and gateway writes, a DynamoDB gateway
endpoint, and a CloudWatch Logs endpoint. Endpoint policies allow only what the gateway
and image pulls need. The VPC resolver remains reachable from private subnets. Isolation
tests must check DNS egress, and a Route 53 Resolver DNS Firewall allow list is the
proposed control if names outside the endpoint set resolve. Challenge CoreDNS
configurations never forward to an upstream resolver.

| Principal                  | Allowed                                                                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session handlers           | `ecs:RunTask` on Challenge task definition families, `iam:PassRole` for the environment execution role only, `ecs:StopTask`, `DescribeTasks`, and `ListTasks` on the cluster, Scheduler operations on session schedules, table access, content reads, pre-signed reads of session objects |
| LLM handler                | Table access for turns and proposals, the provider credential                                                                                                                                                                                                                             |
| Gateway task role          | Session items and tickets in the table, `PutObject` under `sessions/`                                                                                                                                                                                                                     |
| Environment execution role | Image pulls and monitor log delivery                                                                                                                                                                                                                                                      |
| Environment task role      | None                                                                                                                                                                                                                                                                                      |

The challenge container's output is not shipped to CloudWatch by default, because the
learner controls it. Enable it only in development environments.

## Trade-offs

Per-session tasks add compute cost, start-up latency of tens of seconds, vCPU quotas that
cap concurrent sessions, and AWS-specific integration. Fargate also disallows privileged
containers, so environments cannot run nested Docker. A single Docker host has fewer
components, but needs provisioned capacity and isolates learners' root shells less
strongly. The same images run under local Docker for testing and on any container host,
which supports the on-premise comparison.

Fargate Spot would lower compute cost but can interrupt a task with a two-minute warning.
Interrupting a learner mid-incident is worse than the saving, so it is not the default.
AWS can also retire Fargate tasks for platform maintenance, which ends a session as
`error` without using up the first attempt.

Keep domain logic, repositories, and the environment launcher behind ports, so the same
behaviour can run on-premise. Compare equivalent authentication, persistence, isolation,
monitoring, and availability, with the same external LLM.

## Local-first development

Start with the local reference image, then implement the production Lambda, DynamoDB,
Scheduler, and ECS boundaries behind injected ports. Use DynamoDB Local and controlled
fake service adapters for local failure tests. Do not build a second local SaaS runtime,
development identity, or Docker launcher. Add the monitor and gateway in focused
increments before the first temporary AWS spike.

Local tests prove image behaviour, validators, recording, and domain logic. They do not
prove Cognito, IAM, VPC isolation, Fargate start-up time, quotas, WebSockets through the
ALB, or REST API streaming. An AWS checkpoint proves only the managed boundaries that it
exercises. The 15 October checkpoint covered the private runtime and CloudFront terminal
path, but not Cognito, API Gateway, session start, or REST API streaming.

## Operational requirements before a hosted pilot

- Deployment configuration validates secrets, identity mode, allowed origins, and the
  cluster, subnets, and security groups each handler may use.
- Budgets and alarms cover running task count, Fargate vCPU use against quota, LLM spend,
  API errors, and throttling.
- The reconciliation sweep runs on a schedule and alarms when it stops an orphaned task.
- Correlation IDs connect API requests, session events, gateway connections, and
  provider timings.
- Logs omit tickets, monitor secrets, provider credentials, full prompts, terminal
  content, and review concerns.
- Per-learner rate limits and the one-active-session limit are enforced before exposure.
- Verify backup and restore, and a small rollback deployment. Published Challenge
  versions keep their task definition revisions for existing sessions.

These are delivery acceptance criteria, not claims of production readiness.
