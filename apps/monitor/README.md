# Challenge monitor

Status: traffic, HTTP measurements, recovery validation, and TCP outage detection are
implemented for the reference Challenge and exercised locally. A bounded authenticated
HTTPS endpoint now controls the local monitor and serves sequenced public frames. The
CPU/memory adapter, file captures, gateway, and AWS integration remain unimplemented.
This increment does not publish a Challenge or mark a session ready.

The TypeScript core uses Node 22 and measures real HTTP results independently of the
learner's services. It aggregates its bounded request records directly because this
increment has no Prometheus exporter or scraper. No Prometheus server, Grafana service,
or AWS credentials are required. ECharts will render the public samples in the later
web application.

## Core interface

`parseConfig()` validates the private manifest and retains only journeys, validators,
and probes. This increment supports HTTP journey steps, journey/checkout validators,
and TCP probes. Unknown kinds, duplicate IDs, unknown references, and excessive request
load fail admission. It never checks a Challenge ID or requires reference fix commands.

`Monitor` accepts a validated config and transport. Its lifecycle is:

1. `verifyInitialState()` confirms at least one validator fails while all probes pass.
   These startup checks do not contribute to the learner's counters.
2. `start()` fixes the measurement origin. Repeating it returns the original time. The
   lifecycle must call it after recording ownership is acknowledged and use that origin
   as `readyAt`.
3. Call `tick()` at least every 25 ms in the local runner. Traffic follows the authored
   rate. Checks run every second without overlap. Samples are emitted every five seconds.
4. `read(cursor)` returns sequenced records with a stable source ID, recording timestamp,
   and a public `metrics` or `timeline` payload. Reads do not delete data. Treat records
   as provisional until the cutoff is sealed. When sealing starts, the cutoff is reserved
   before any wait, so later reads cannot return records beyond it.
5. `seal(cutoff)` stops work, cancels unfinished requests, and returns the final metrics.
   Repeating it returns the same result. A different cutoff is rejected. Reads after
   sealing exclude records learned after the cutoff, including backdated outage events.

The core cutoff must be between start and the current monitor time. Durations and
timestamps use a monotonic clock anchored to the initial wall clock. The control layer
accepts a lifecycle cutoff at most five seconds ahead, waits until the monitor clock
reaches it, and seals at the exact supplied time. A monitor restart or loss of its
buffer is an incomplete recording, not a new zero-valued measurement stream.

The core does not write DynamoDB, decide session outcomes, or upload recordings.
The future gateway will save the records and relay only public payloads.

## HTTPS control

The runtime listens on port 9443 with TLS 1.3. The gateway must verify the per-task
certificate before it sends the 32-byte base64url session secret. The monitor reads its
certificate, private key, and secret from its own environment. The Challenge container
does not receive them. Production must deliver all three values through the encrypted
per-session S3 environment file, never through a plaintext `RunTask` override. Certificate
issuance and production delivery are not implemented.

| Operation                         | Result                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `GET /healthz`                    | Authenticated `starting`, `ready`, or `failed` status with no private detail |
| `POST /v1/start`                  | Idempotently starts measurement and returns `startedAt`                      |
| `GET /v1/frames?after=<sequence>` | Returns up to 100 public frames, the next sequence, and seal state           |
| `POST /v1/seal`                   | Idempotently seals the immutable `cutoffAt` and returns final metrics        |

All operations require the bearer session secret. Plain HTTP fails. Requests have
fixed JSON errors and never return manifests, validator definitions, probe definitions,
credentials, or internal errors. The server caps request bodies at 1 KiB, headers at
2 KiB, active connections and concurrent requests at 16, authenticated requests at 32 per second, and
unauthenticated requests at 8 per second. Requests time out after six seconds.

## Measurements

| Value                             | Definition                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_rate`                    | Ordinary journey requests completed in the last five seconds divided by that interval. Use the elapsed interval for the first partial sample |
| `error_rate`                      | Failed ordinary requests divided by completed ordinary requests in that same window, in percent                                              |
| `latency_p95`                     | Exact nearest-rank p95 of those request durations, in milliseconds. Includes failed attempts and timeouts                                    |
| `totalRequests`, `failedRequests` | Cumulative ordinary request completions from measurement start through the requested cutoff                                                  |

A journey stops at its first failed step. Each attempted step counts once. Validator
and probe traffic is excluded. A request started before measurement or completed after
the cutoff is excluded. Completion-ordered records and cumulative failure prefixes allow
live and historical cutoff reads without changing counters. Only the five-second window
is sorted for the exact percentile.

No completed requests means zero observed request rate, with error rate and latency
absent. CPU and memory are absent until the Challenge runtime-statistics adapter exists.
A monitor data gap is an explicit failure, never zero customer impact. A fast 502 can
have low latency, so latency is not a recovery test.

Checkout validation creates a fresh reference, requires a confirmed order, and reads
that same order back. All validators must sustain success for their authored periods.
A failed check resets its window. If the scheduler misses a validator slot while no
check is running, the window resets. A check still running at the next slot remains
authoritative and is not overlapped or changed into a failure.
TCP probes emit an outage only after the authored grace period, using the first failed
probe's completion time. Probe labels describe symptoms, not hidden causes.

## Bounds and failure behavior

- Canonical authored loopback HTTP targets only. No redirects, automatic request retries,
  environment proxy use, or unrestricted command execution.
- Per-request deadline from the manifest, including socket wait and body download.
  Responses are capped at 64 KiB and headers at 8 KiB. Cancellation closes pending I/O.
- Admission rejects more than 20 ordinary requests/second and also rejects any workload
  whose records cannot fit across the public four-hour session maximum plus one minute
  of sealing headroom. The record budget is the stricter bound for sustained traffic.
  At most 32 tasks can be in flight. These are monitor implementation limits, not
  product concurrency claims.
- At most 150,000 request records, 100,000 recovery records, and 10,000 output records.
  Admission checks request and recovery history against those bounds. Reaching another
  limit stops the monitor with a fixed error code.
- A scheduling delay under five seconds skips missed work and resumes at the current
  slot without a catch-up burst. The observed request rate shows the reduced traffic.
  A gap of five seconds or more stops measurement as `schedule_gap`.
- The HTTPS runtime logs fixed error codes and never dumps manifests, response bodies,
  credentials, or stack traces.

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

The image suite starts the existing shop, a separate monitor container, and a bounded
gateway-like client. They share only the shop's network namespace. The monitor uses a
read-only root, no capabilities, a non-root user, 0.5 CPU, 128 MiB memory with swap
disabled, 64 PIDs, and a bounded private temporary filesystem. No host port, Docker
socket, or internet route is available.
All are removed after testing, including failures. The existing standalone Challenge
runner and service image are unchanged.

Tests verify the real fault, failed reload, unsafe restart, reference repair, and an
alternative repair that moves the application listener. Both repairs wait the actual
60-second sustain period. They also verify TLS identity, bearer authentication, plaintext
rejection, cursor reads, immutable sealing, and access from the learner network without
credentials. Unit tests use real loopback HTTP servers for malformed and slow responses,
and controlled clocks for scheduler and cutoff races.

The Dockerfile's default `runtime` target contains only `runtime.cjs`. The local image
command selects a separate `test` target that adds the private reference manifest and
gateway substitute. `dist/monitor/core.cjs` remains a reusable build artifact outside the
runtime image. The gateway substitute starts measurement, polls and resumes by sequence,
and seals on SIGTERM. It exists only for integration tests and is not the real gateway or
cloud lifecycle.

Local Docker checks do not prove Fargate isolation, cloud timing, or complete recording.
The complete monitor publication harness, including repeated scenario runs, remains a
later gate. See [the contract](../../docs/challenges.md#monitor) and
[the measurement](../../docs/decisions/monitor-measurement.md) and
[control](../../docs/decisions/monitor-control.md) decisions.
