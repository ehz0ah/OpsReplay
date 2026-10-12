# Durable Gateway live telemetry

Status: implemented and tested locally, AWS validation pending
Date: 13 October 2026
Owner: Gateway contributors

## Decision

Publish the latest validated public Monitor metric as one replaceable `LIVE_MONITOR`
item in the session partition. The recorder writes it in the same fenced DynamoDB
transaction as the accepted page reference, recording cursor, event projection, and
lifecycle observation. The item carries the session, Monitor source, recording start,
accepted frontier, metric sequence, and recording timestamp.

Keep this projection separate from `MONITOR_OBSERVATION`. The observation preserves the
first sustained recovery for lifecycle correctness. The live item may advance to a later
sample. A stale recorder, rejected page, or failed transaction cannot publish it.

The browser-owning Gateway reads DynamoDB. It does not depend on an in-process recorder
map, so another Gateway can own recording. One consistent transaction verifies session
state, terminal input ownership, recording state, command frontier, and the live metric.
Reads are bound to the admitted session, connection ID, and input generation. Clients
cannot provide task addresses, Monitor credentials, or subscription targets.

On attachment, return the latest metric and establish current command and Monitor
frontiers. Do not replay prior events. Later five-second polls read at most 20 completed
commands and one Monitor event page of at most 100 events. Combined event data is limited
to 120 events and 512 KiB. Polls do not overlap. Metrics are coalesced; event cursors
advance only through validated durable receipts.

Use the existing bounded WebSocket send queue. A slow send stops polling and reaches the
one-second send deadline. Browser closure, Gateway shutdown, or input replacement cancels
the active read. A terminal session status stops live work.

After authorization succeeds, a transient evidence-read failure sends one fixed
`TELEMETRY_UNAVAILABLE` error per outage and retries on the normal interval. Failure to
verify authorization closes the connection. The timeline API remains authoritative for
history and reconnect catch-up. This design does not promise durable WebSocket replay or
exactly-once delivery.

## Reason

A local recorder callback would fail when recorder Gateway A and browser Gateway B are
different processes. A durable projection preserves that topology without a broker,
another Monitor stream, or Gateway-to-Gateway routing. Reusing existing command and
Monitor receipts avoids a second evidence model.

## Limits

This increment does not add a dashboard UI, new measurements, Prometheus, Grafana,
proposals, or a public subscription API. Local and DynamoDB Local tests cover atomic
publication, response loss, replacement, bounded deltas, terminal outcomes, slow sends,
and cross-Gateway reads. They do not prove managed DynamoDB consistency, IAM, ALB
WebSockets, Fargate scheduling, or production load. No deployment or image publication is
part of this decision.
