# First monitor measurement increment

Date: 6 October 2026. Scope: the reference Challenge's traffic, metrics, recovery,
and outage checks. Gateway, browser rendering, captures, and cloud deployment remain
separate work. The Challenge stays draft.

## Choices

Use TypeScript on Node 22 to share the API/gateway language and public data contracts.
Aggregate the bounded request outcomes directly. An earlier version rebuilt a
Prometheus client registry for every snapshot, but this increment exposes no scrape
endpoint and runs no collector. Direct aggregation avoids an asynchronous seal race,
uses an exact nearest-rank p95, and removes an unused production dependency. Reconsider
a Prometheus client only when the monitor has a real exporter requirement.

Use a separate sidecar for measurements. It generates real customer requests and runs
private checkout validators independently of the learner-controlled services. HTTP
status alone does not establish recovery. No particular command or configuration text
is required, so an alternative repair remains valid.

Keep timestamped request outcomes. Aggregated counters alone cannot reconstruct an
earlier session cutoff after delayed outcome delivery. Completion-ordered records use
cumulative failure prefixes for historical counters, and each snapshot sorts only its
five-second duration window. The p95 window matches the request/error-rate window. The
150,000-request and 100,000-recovery bounds are checked at admission against the public
four-hour session maximum plus one minute of sealing headroom. This capacity check is
independent of the manifest's Free-plan duration. Higher-rate manifests are rejected.

No Prometheus server or Grafana service is needed for this increment. The later gateway
will relay the existing public metric/event shapes, and the web workspace will render
them with Apache ECharts. Neither chart code nor a generic telemetry platform is added
here. CPU/memory must come from the Challenge runtime, not the monitor process.

Use an in-process lifecycle and sequenced buffer before exposing network control.
The later authenticated-control increment replaced the temporary stdout driver. The
runtime image does not contain that driver or another path around the HTTPS control API.

## Timing and failures

Requests complete once, without hidden retries. Warm-up requests and independent
validator/probe requests do not enter incident counters. The start and end boundaries
are immutable. The platform lifecycle owns the outcome time; normal session expiry is
not a monitor failure. The gateway seals at that cutoff. Cancellation during sealing
does not count the interrupted request as a failed customer operation. Already completed
requests before the cutoff still count.

Sustain windows advance only through completed passing evaluations. A validator that
is still running at its next slot is not overlapped or converted into a failure. Its
completed result remains authoritative. A missed slot while no check is running resets
the window. A scheduling delay under five seconds skips missed work and resumes without
a burst. A delay of five seconds or more, or an exhausted buffer, fails measurement.

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
[implementation and checks](../../apps/monitor/README.md), and
[Apache ECharts](https://echarts.apache.org/).
