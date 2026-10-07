# Recording deployment increment

Status: implemented locally, AWS validation pending
Date: 8 October 2026
Owner: Hao Zhe

## Context

The lifecycle can publish recording work and the gateway can supervise it, but neither
component has a connected runtime. Local library tests do not prove ECS events, managed
DynamoDB and S3 behavior, IAM, or private Fargate networking.

## Decision

Deploy the recording publisher as its own Node.js Lambda. An ECS task-state rule selects
`RUNNING` events from the configured cluster. Delivery and asynchronous invocation use
bounded retries, a two-minute event age, one encrypted dead-letter queue, and alarms.
The handler still validates the session ID, task identity, cluster, and private address.

Run the recording supervisor as one private Fargate worker by default. Its image is
non-root, read-only, capability-free, and selected by an ECR digest. The process creates
one random recorder ID, shares bounded AWS clients, converts termination signals to
cancellation, waits for its runners, and closes the clients. It has no listener, public
IP, load balancer, or browser route.

Use the `unfinished-work` global secondary index only for discovery. Store recording
objects in a separate retained, encrypted, private bucket. The gateway task role can
query only that index, operate only on `SESSION#*` table items needed by recording, and
write only `sessions/*` objects. The execution role only pulls the gateway image and
writes its log group.

The gateway has its own security group with no inbound rules. It can connect on TCP 9443
only to a deployment-supplied environment-monitor security group. The stack adds the
matching inbound rule. The supplied subnets must have no internet or NAT route and must
provide private access to DynamoDB, S3, ECR, and CloudWatch Logs.

One `EnableRecordingPath` parameter controls the three coupled components. It defaults
to `false`, which disables the event rule, reserves zero publisher concurrency, and runs
zero gateway tasks. Enabling it is allowed only for the approved AWS checkpoint.

## Limits and validation

The desired worker count and per-worker concurrency are bounded parameters. They do not
provide a global admission limit. Session start therefore remains disabled. Readiness,
outcome, drain initiation, finalisation, the terminal proxy, and browser relay remain
separate work.

Local tests cover runtime configuration, unique process identity, failure propagation,
client cleanup, container discovery through DynamoDB Local, graceful container shutdown,
the exact event pattern, failure queue, index, bucket, IAM, task definition, network
rules, and inactive defaults. These checks do not prove AWS behavior. A temporary school
account run must validate two concurrent attachments, event delivery, private network
access, managed persistence, lease takeover, cleanup, latency, and retained resources.
