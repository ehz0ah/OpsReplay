# Run reproducible evaluations

These tools prepare measurement evidence for I10/I11. They do not deploy, publish
content, launch tasks, change quotas or establish capacity. All live runs are explicit.
Use Node 22 and keep configuration and results under ignored `.local/evaluation/`.
Output JSON is private and cannot overwrite an existing file.

## Local scenario repeats

Build the Challenge, Monitor and Monitor test-client images first using their documented
commands. Then run the existing fault, trap, repair, checkout and sustained recovery
suites serially, up to 20 repeats:

```sh
npm run evaluation:scenarios -- wrong-upstream-port:20 .local/evaluation/upstream.json --run
npm run evaluation:scenarios -- stale-dns-record:20 .local/evaluation/dns.json --run
```

Each suite has a 15-minute limit and an 8 MiB output limit. A failure stops repeats.
Reports bind the Git revision, manifest hash and local image IDs. Changed image IDs fail
the run. Reported duration is suite duration, not time to learner recovery. Forced
termination can interrupt test cleanup. Inspect only the named OpsReplay test containers
and networks after interruption. Do not remove unrelated Docker resources.

## Existing-session API and terminal load

Create independent test learners and ready sessions during the approved AWS window.
Do not use participant sessions. Connections take terminal ownership and send Ctrl-C
followed by a harmless unique `printf`. They can interrupt a command already running.
Each worker has one token and one session, and sends catalogue, account, session and
terminal-ticket requests followed by a terminal probe. Failed reads stop that worker.
There is no automatic retry or token refresh.

Private configuration fields:

| Field               | Value                                                                   |
| ------------------- | ----------------------------------------------------------------------- |
| `baseUrl`, `origin` | Verified HTTPS API base including its stage, and exact browser origin   |
| `concurrency`       | 1 to 100, no more than authorised sessions and Fargate quota            |
| `rounds`            | 1 to 100                                                                |
| `thinkTimeMs`       | 0 to 60000                                                              |
| `timeoutMs`         | 1000 to 30000 per operation                                             |
| `participants`      | Exactly one distinct `{ "token": "...", "sessionId": "..." } per worker |

```sh
npm run evaluation:load -- .local/evaluation/load-config.json .local/evaluation/load-result.json --run
```

The report records attempted operations, HTTP status, failures, duration distributions,
terminal admission and command round-trip latency. The octal-escaped probe avoids
counting input echo as command output. Tokens, session IDs, endpoints and terminal
output are omitted. Requests per second describes the measured mix, not maximum
throughput. This runner does not measure task-start latency. Record start acceptance and
`readyAt` separately in the integrated checkpoint. Record deployed revisions, limits,
Region, Fargate quota, runtime window and CloudWatch errors/throttles beside the report.

## Assistant benchmark

Eight synthetic cases cover investigation, evidence comparison, log injection, hidden
answer requests, truncated output, DNS partial recovery, sustaining recovery and unsafe
restart. They use the production provider adapter. Review the configured provider's
data terms and set a provider-enforced spend cap before running. Use published prices.
Set `OPSREPLAY_EVAL_PROVIDER_KEY` privately in the process environment.

The private config has `endpoint`, `model`, positive `inputUsdPerMillion`, positive
`outputUsdPerMillion`, positive `maxEstimatedUsd`, and `repeats` from 1 to 3.

```sh
npm run evaluation:assistant -- .local/evaluation/provider-config.json .local/evaluation/assistant-result.json --run
```

Calls run serially with a 45-second deadline and 1200 output-token cap. Missing token
usage or provider failure stops further calls. Failed calls reserve their conservative
estimated cost. Local budget checks are estimates, not a billing guarantee. Reports
include response text, proposals, token counts, latency and review fields. They use no
real learner data. Do not commit provider output or keys.

The report separates planned, attempted, completed, failed and usage-missing calls.
Failure rates use attempted calls as their denominator and remain `null` when no
call was attempted. `durationMs` includes every attempted call;
`completedDurationMs` includes completed replies only. `firstDeltaMs` measures the
first non-whitespace streamed text in completed replies. A reply with no streamed
text has no first-delta sample, even if its final text is valid.

`costAccounting.reportedUsageUsd` uses returned token counts. `reservedUsd` retains
the estimate for calls whose usage is unavailable; it is not measured spend. Each
result records its estimate and `costBasis`. The existing `estimatedUsd` total is
their sum. Reaching the limit exactly after the final case completes the run;
reaching it before another case prevents that next call. Exceeding it stops the run.

A reviewer must score relevance, teaching accuracy, unsupported facts, leakage and
destructive suggestions against each rubric. Lexical flags can include negated warnings
and miss paraphrases. They are not accuracy scores. Report denominators and failures.
Adapter latency excludes the deployed API, state and context-building round trip.
Measure those separately during the AWS checkpoint.

## GET-only existing-session load

Use `evaluation:read-load` when measuring catalogue, account and owned-session
reads without terminal control. It sends only `GET /v1/catalog`, `GET /v1/me` and
`GET /v1/sessions/{id}`. It does not request terminal tickets, open sockets, send
commands, refresh learner activity or change session state. An assigned session
can be ready, completed or in another valid lifecycle state. Its returned ID must
still match the configured session.

Use the same private configuration fields and bounds as terminal load. `origin`
is validated for configuration compatibility but is not sent in this mode.
Each worker must have a distinct operator-owned learner and existing session.
Live reads still require an approved test window and request-volume budget.
No ready Fargate task is needed for reads of completed sessions.

```sh
npm run evaluation:read-load -- .local/evaluation/read-config.json .local/evaluation/read-result.json --run
```

The report kind is `existing-session-read-load`. It includes the three GET
operation distributions and omits terminal latency fields. Failed HTTP, schema
or identity checks stop that worker without retries. Requests per second and
latency describe this read mix only, not terminal performance, provisioning,
maximum SaaS capacity or paid-customer limits. The existing `evaluation:load`
command retains its ready-session requirement and terminal-control behavior.

## Verification and cost

`npm run evaluation:test` uses local fixtures and a fake provider. CI runs it without
AWS or paid calls. Cloud transport, quota and billing remain unverified.

For the final cost comparison, record actual runtime seconds, task sizes, completed
sessions, API/Lambda/DynamoDB use and storage. Include ALB, endpoints and Gateway idle
cost. Use dated regional rates and separate credits. Compare the same container images
on a host sized for the measured concurrent load. Record hardware life, power, network,
maintenance and availability assumptions. External LLM prices apply to both hosts.
