# Challenge monitor

Status: traffic, HTTP measurements, recovery validation, and TCP outage detection are
implemented for the reference Challenge and exercised locally. The authenticated
control endpoint, CPU/memory adapter, file captures, gateway, and AWS integration remain
unimplemented. This increment does not publish a Challenge or mark a session ready.

The TypeScript core uses Node 22 and `@prometheus-io/client` (formerly `prom-client`).
It measures real HTTP results independently of the learner's services. No Prometheus
server, Grafana service, AWS credentials, or listening monitor port is required here.
ECharts will render the public samples in the later web application.

## Core interface

`parseConfig()` validates the private manifest and retains only journeys, validators,
and probes. This increment supports HTTP journey steps, journey/checkout validators,
and TCP probes. Unknown kinds, duplicate IDs, unknown references, and excessive request
load fail admission. It never checks a Challenge ID or requires reference fix commands.

`Monitor` accepts a validated config and transport. Its lifecycle is:

1. `verifyInitialState()` confirms at least one validator fails while all probes pass.
   These startup checks do not contribute to the learner's counters.
2. `start()` fixes the measurement origin. Repeating it returns the original time.
3. Call `tick()` at least every 25 ms in the local runner. Traffic follows the authored
   rate. Checks run every second without overlap. Samples are emitted every five seconds.
4. `read(cursor)` returns sequenced records with a stable source ID, recording timestamp,
   and a public `metrics` or `timeline` payload. Reads do not delete data. Treat records
   as provisional until the cutoff is sealed.
5. `seal(cutoff)` stops work, cancels unfinished requests, and returns the final metrics.
   Repeating it returns the same result. A different cutoff is rejected. Reads after
   sealing exclude records learned after the cutoff, including backdated outage events.

The cutoff must be between start and the current monitor time. Durations and timestamps
use a monotonic clock anchored to the initial wall clock. Future gateway integration must
establish how the platform's outcome timestamp maps to this clock. A monitor restart or
loss of its buffer is an incomplete recording, not a new zero-valued measurement stream.

The core does not write DynamoDB, decide session outcomes, or upload recordings.
The future gateway will authenticate to the monitor, save its records, and relay only
public payloads. Do not expose this in-process interface as an unauthenticated server.

## Measurements

| Value | Definition |
| --- | --- |
| `request_rate` | Ordinary journey requests completed in the last five seconds divided by that interval. Use the elapsed interval for the first partial sample |
| `error_rate` | Failed ordinary requests divided by completed ordinary requests in that same window, in percent |
| `latency_p95` | Prometheus Summary's interpolated p95 of those request durations, in milliseconds. Includes failed attempts and timeouts |
| `totalRequests`, `failedRequests` | Cumulative ordinary request completions from measurement start through the requested cutoff |

A journey stops at its first failed step. Each attempted step counts once. Validator
and probe traffic is excluded. A request started before measurement or completed after
the cutoff is excluded. Snapshot registries are private to each read, allowing live and
historical cutoff reads without changing counters. Bounded timestamped records supply
the window and cutoff selection before the metrics library aggregates them.

No completed requests means zero observed request rate, with error rate and latency
absent. CPU and memory are absent until the Challenge runtime-statistics adapter exists.
A monitor data gap is an explicit failure, never zero customer impact. A fast 502 can
have low latency, so latency is not a recovery test.

Checkout validation creates a fresh reference, requires a confirmed order, and reads
that same order back. All validators must sustain success for their authored periods.
A failed or missed evaluation resets its window and invalidates any outstanding result.
TCP probes emit an outage only after the authored grace period, using the first failed
probe's completion time. Probe labels describe symptoms, not hidden causes.

## Bounds and failure behavior

- Canonical authored loopback HTTP targets only. No redirects, automatic request retries,
  environment proxy use, or unrestricted command execution.
- Per-request deadline from the manifest, including socket wait and body download.
  Responses are capped at 64 KiB and headers at 8 KiB. Cancellation closes pending I/O.
- Admission caps ordinary traffic at 20 requests/second at maximum journey length and
  reserves space for checks, sampling, and worst-case request overlap. At most 32 tasks
  can be in flight. This is a monitor implementation limit, not a product concurrency claim.
- At most 100,000 request records, 100,000 recovery records, 10,000 output records, and
  four hours of measurement. Reaching a limit stops the monitor with a fixed error code.
- Missing an entire traffic/check scheduling slot stops measurement as `schedule_gap`.
  Busy validators fail that evaluation instead of overlapping. No catch-up request burst.
- The local output driver waits for writes and fails after one second of blocked output.
  It logs fixed error codes and never dumps manifests, response bodies, or stack traces.

These bounds need load measurements before expanding beyond the reference Challenge.

## Local checks

Use Node 22, npm, and Docker from the repository root:

```sh
npm ci
npm run typecheck
npm run monitor:test
npm run challenge:build
npm run monitor:image:build
npm run monitor:image:test
```

The image suite starts the existing shop and a separate monitor container sharing only
its network namespace. The monitor uses a read-only root, no capabilities, non-root user,
0.5 CPU, 128 MiB memory with swap disabled, 64 PIDs, and a bounded private temporary
filesystem. Neither container exposes a port, Docker socket, or internet route.
Both are removed after testing, including failures. The existing standalone Challenge
runner and service image are unchanged.

Tests verify the real fault, failed reload, unsafe restart, reference repair, and an
alternative repair that moves the application listener. Both repairs wait the actual
60-second sustain period. Unit tests use real loopback HTTP servers for malformed and
slow responses, and controlled clocks for scheduler and cutoff races.

The Dockerfile builds a **test image** with the private reference manifest and bounded
driver. `dist/monitor/core.cjs` is the reusable core bundle. The driver accepts a private
manifest path and a duration from 1 to 1200 seconds. It verifies startup, starts locally,
and writes JSON records to stdout. SIGTERM seals the run. It is not the cloud lifecycle,
an authenticated gateway adapter, or a general local SaaS runtime.

Local Docker checks do not prove Fargate isolation, cloud timing, or complete recording.
The complete monitor publication harness, including repeated scenario runs, remains a
later gate. See [the contract](../../docs/challenges.md#monitor) and
[the implementation decision](../../docs/decisions/monitor-measurement.md).
