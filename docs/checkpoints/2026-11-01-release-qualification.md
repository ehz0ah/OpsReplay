# Release qualification, 1 November 2026

Tested source: `5c33055c59846c784f978ababd2075fe2b3dad90` (merged PR #135).
Application Region: `ap-southeast-1`; terminal edge: `us-east-1`.

One grouped campaign used two new operator-created test identities, six attempts,
at most two concurrent Challenge tasks and one Gateway service. This is acceptance
evidence for the tested workload. It does not establish classroom capacity,
learning benefit or general production security. The 29 October inbox sign-up and
450-GET measurements remain separate historical evidence.

## Exact-image qualification

Hosted publications [41282269440](https://github.com/ehz0ah/OpsReplay/actions/runs/41282269440)
and [41282275495](https://github.com/ehz0ah/OpsReplay/actions/runs/41282275495) passed
for the frozen source. Artifact digests, image configuration and fresh ECR findings
were compared before admission. Both Gateway and both Monitor image scans reported
no findings. Each Challenge scan reported one HIGH, three MEDIUM and three LOW,
with no CRITICAL or UNKNOWN findings.

| Image              | SHA-256 digest                                                     |
| ------------------ | ------------------------------------------------------------------ |
| Upstream Gateway   | `9ec503daf9fa455fd1e4516c0772c3200df3c551da6eb5add09ec82df2db3bb9` |
| Upstream Monitor   | `009775f127d43777e2e9ba202085632892a01f1ef7af041aa6b8c5a0511470b6` |
| Upstream Challenge | `98b08d1b96c27fadb50e2297b6c19261e52710547bf472d36aee32aad85d7e97` |
| DNS Gateway        | `e2c9d9221523e6cb2bc3629ccb8487f0073a9b310ba0ef535e3ea1dcad3c2a66` |
| DNS Monitor        | `ec99d7d24f63abd8ffb9d01c950f164181c59aae1acfd90e642f6477363d27e5` |
| DNS Challenge      | `9b4bb3a0d5f3cabfa6f91e79e4a330e3d22f086648ca750cde84148fdb449ddb` |

The HIGH `CVE-2026-84243`, MEDIUM `CVE-2026-86805` and LOW `CVE-2026-95818`
map to the [new owner acceptance](https://github.com/ehz0ah/OpsReplay/pull/135#issuecomment-6553187929).
The other findings remain: MEDIUM `CVE-2026-85231`, `CVE-2026-85977`; LOW
`CVE-2026-97399`, `CVE-2026-27205`. Scans are not suppressed. The expired
29 October exception was not reused. Deployed checks confirmed root learners,
native libc, separate Monitor, no task IAM role, private routes and Gateway-only
ingress. Acceptance is conditional on this deployment model, not a universal waiver.

## Hosted gameplay and recovery

| Case                 | Result                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted identity      | PKCE login and fixed-window Pro access passed with a new operator-created learner. No new inbox-registration result.                                     |
| Start response loss  | Discarded response and same-request replay recovered one session and task.                                                                               |
| Original idle socket | Survived 610 seconds with no terminal input or reconnect; presence heartbeats remained active.                                                           |
| Login expiry         | An expired five-minute token returned 401; fresh authentication recovered the same active attempt.                                                       |
| Disconnect           | The replacement connection reported a resumed shell; repair then resolved the same attempt.                                                              |
| DNS repair           | DNS-only change left checkout at 502. Validated reload then produced 60 seconds of sustained recovery.                                                   |
| Gateway loss         | The exact owned Gateway task was stopped. ECS replaced it; the same attempt resumed and resolved.                                                        |
| Explicit end         | Ending a ready unresolved attempt and repeating the request preserved `ended` / `learner_ended`.                                                         |
| Actual deadline      | Verification in progress.                                                                                                                                |
| Recording/debrief    | Five completed attempts finalized with complete recordings. All 38 exported objects matched stored SHA-256 references; final deadline export is pending. |
| Browser playback     | History distinguished first/retry results. Debrief, play/pause, command seeking and recorded telemetry were checked on the Gateway-loss result.          |
| Scoped deletion      | Verification in progress.                                                                                                                                |
| Cleanup              | Verification in progress.                                                                                                                                |

Gateway replacement also disconnected the concurrent deadline attempt's heartbeat
socket. That attempt correctly ended as `abandoned` / `heartbeat_missed`, with a
complete recording; it is not counted as a deadline pass. The sixth, final attempt
runs the actual 30-minute deadline without a further Gateway-loss test.

The proposal helper initially expected `completed`, but the public contract returns
`accepted`. The saved first proposal and counter confirmed one acceptance. A second,
read-only proposal used the correct contract: explicit confirmation, repeated
confirmation and a status query returned `accepted`, with one counter increment.
The helper failure is retained privately. It is not an application-completion failure.

## Assistant measurements

The configured Ark account is permitted for this demo. Provider-console cap
verification was not a prerequisite under the owner's instruction. Requests,
tokens, time and retry bounds remained in force; the campaign stopped at 24
provider attempts. No enforced provider or AWS billing cap is claimed.

Six ordinary synthetic cases were planned for three repeats. The original run
attempted 11 calls and failed on one. An explicitly separate eight-call supplement
completed the missing repeats. The pooled baseline is 19 attempted, 18 completed,
one failed (5.26%). The original failed stream was not captured, so its cause is
unknown. A successful separate protocol diagnostic does not erase that failure.

Completed adapter calls had p50 4616 ms and p95 6013 ms. Agent manual rubric review
found relevant proposals in 18/18 completed replies, teaching accuracy in 17/18,
and unsupported facts in 4/18. No destructive proposal was identified in these
ordinary cases. These are separate rubric dimensions, not independent human
grades or a security benchmark. Injection and hidden-answer fixtures were excluded.

PR [#137](https://github.com/ehz0ah/OpsReplay/pull/137) clarifies unlabelled socket
ownership and tested-file versus loaded-process configuration. Two separate
targeted calls made these distinctions explicit. They are qualitative checks;
they do not establish post-fix accuracy. The AWS campaign used the pre-fix source.

| Deployed call                | Full stream duration | First text delta | Outcome                                                                                                          |
| ---------------------------- | -------------------: | ---------------: | ---------------------------------------------------------------------------------------------------------------- |
| Evidence investigation       |              8574 ms |          5019 ms | Saved explanation and read-only proposal; no automatic execution.                                                |
| Socket proposal confirmation |              6643 ms |             None | Tool-only provider reply; saved fallback text and exact `ss -ltnp` proposal. Explicit confirmation counted once. |

Both deployed streams completed. With only two observations, no population p95 or
general failure-rate guarantee is claimed. The tool-only reply did not provide the
requested explanatory text; the saved fallback is not counted as a provider delta.
CloudWatch records confirmed 3172 input and 1178 output tokens across these calls.

At the dated rate/FX assumptions, reported-usage estimates are US$0.0073083 for the
baseline and US$0.0011263 for the deployed pair. The baseline's failed call retains
a separate US$0.0013201 reservation. Diagnostic and fix calls are separate. These
are token-based estimates, not invoices or the complete campaign charge.

## Cost, preservation and remaining work

The campaign's US$5 planning target is not a hard cap. Same-day Cost Explorer data
had no posted services for this day when inspected; it does not establish zero cost.
Final attributed charges require later billing data. The
[equivalent-service comparison](../reports/final/cost-comparison.md) retains dated
rates, capacity boundaries and explicit assumptions.

Learner outcomes remain uncollected. Operator acceptance and browser testing do
not replace the [formative pilot](../evaluation/pilot/README.md). Its facilitator,
contact, consent, private deletion date and participant availability remain team
dependencies. Hosting capacity, on-premise power/operator measurements, a qualified
host quote and presentation rehearsal also remain open.

Private receipts, tokens, account/session IDs, recordings, provider replies and
deletion snapshots are held in the operator-local `challenge-qualification-20261101`
campaign folder. Only aggregate results and image digests are published here.
