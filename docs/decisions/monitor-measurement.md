# First monitor measurement increment

Date: 6 October 2026. Scope: the reference Challenge's traffic, metrics, recovery,
and outage checks. Gateway, browser rendering, captures, and cloud deployment remain
separate work. The Challenge stays draft.

## Choices

Use TypeScript on Node 22 to share the API/gateway language and public data contracts.
Use the established Prometheus Node client for metric instruments and interpolated
latency quantiles. The current package is `@prometheus-io/client`, formerly
`prom-client`. Version 0.16.1 is pinned and supports Node 22. The dependency is bundled
only where imported by the monitor. The Lambda entry points do not import it.

Use a separate sidecar for measurements. It generates real customer requests and runs
private checkout validators independently of the learner-controlled services. HTTP
status alone does not establish recovery. No particular command or configuration text
is required, so an alternative repair remains valid.

Keep timestamped request outcomes. Aggregated counters alone cannot reconstruct an
earlier session cutoff after delayed outcome delivery. Each snapshot selects its
records before feeding a separate library registry. The p95 window is five seconds,
matching the request/error-rate window. This bounded approach is sufficient for the
first Challenge, but its CPU and memory cost must be measured before raising limits.

No Prometheus server or Grafana service is needed for this increment. The later gateway
will relay the existing public metric/event shapes, and the web workspace will render
them with Apache ECharts. Neither chart code nor a generic telemetry platform is added
here. CPU/memory must come from the Challenge runtime, not the monitor process.

Use an in-process lifecycle and sequenced buffer before exposing network control.
The test image supplies a bounded local driver. It has no control port to bypass the
authenticated TLS requirement. The driver is not a deployed readiness handler.

## Timing and failures

Requests complete once, without hidden retries. Warm-up requests and independent
validator/probe requests do not enter incident counters. The start and end boundaries
are immutable. Cancellation during sealing does not count the interrupted request as
a failed customer operation. Already completed requests before the cutoff still count.

Sustain windows advance only through completed passing evaluations. A busy check at
the next slot resets its window and invalidates its outstanding result. A skipped
scheduler slot or exhausted buffer fails measurement explicitly. This may reject a run
under excessive monitor load, but it cannot award recovery using missing evidence.

The monitor uses monotonic elapsed time anchored to wall time. Distributed clock
alignment, durable recording, and monitor restart recovery remain integration concerns.
Local output records are provisional until sealed. Records learned after the cutoff
are excluded even when their event time was backdated, such as an outage after grace.

## Validation boundary

Unit tests cover cutoff selection, counter isolation, quantiles, missed checks, output
backpressure, and invalid network responses. Image tests exercise real nginx, shop,
and PostgreSQL behavior, including a full 60-second recovery period and an alternative
repair. They do not establish Fargate isolation or complete Challenge publication.

Sources: [monitor contract](../challenges.md#monitor),
[implementation and checks](../../apps/monitor/README.md),
[Prometheus Node client](https://github.com/prometheus/client_js), and
[Apache ECharts](https://echarts.apache.org/).
