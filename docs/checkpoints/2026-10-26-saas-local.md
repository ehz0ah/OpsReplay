# SaaS local status, 26 October 2026

This is an implementation and evidence snapshot, not a deployment or completion
claim. The submitted report and earlier checkpoint documents remain historical.

## Current changes

The integrated frontend head `f89e2583ce346099cb53679b150ada4538044224`
includes an incident-lab identity, pricing/account pages and a labelled no-payment
demo upgrade. The backend grant is default-off, operator-allowlisted and fixed-window.
It stores an atomic request receipt and preserves existing effective Pro access.
Activation does not start an environment or change a saved attempt.

The contract-check script now lists separate browser checks instead of saying
the web app is unimplemented. Its validation logic is unchanged.

The initial focused review stack is #116, #119, #117, #115 and draft #118.
The then-current pushed heads passed repository CI. The integrated head passed nine repository
jobs and its title check. No PR was merged as part of this delivery.

Local checks passed: 341 API, 35 infrastructure, 89 browser-code, 37 private
contract, 107 script, 19 content and eight evaluation-tool tests. Full and
production npm audits reported no known findings. Registry image scans are a
separate gate. The production web build retains a large-chunk warning.

Two preliminary local repeats per implemented Challenge passed their Challenge
and Monitor suites with unchanged image IDs and matching manifest hashes. Their
test-owned containers, networks and volumes were absent afterward.

At 08:01 SGT, both full 20-repeat reports were independently verified at the
unchanged `f89e2583ce346099cb53679b150ada4538044224` revision. Each report has 40
successful Challenge/Monitor suite executions, matching ordered repeats,
version `0.1.2`, manifest hashes and current image IDs. The original combined
process exited 0. No test-owned Docker containers, networks or volumes remained;
the two preexisting volumes were preserved. The subsequent offer correction and
font/status follow-ups do not change the Challenge or Monitor images.
The full reports remain in operator-local evaluation artifacts. Suite duration
is not learner recovery time, AWS Fargate performance or a cost measurement.

## Retained catalogue and runtime

A read-only, consistent query on 26 October returned these five published entries:

| Mode        | Free                            | Pro                                  |
| ----------- | ------------------------------- | ------------------------------------ |
| Challenge   | `wrong-upstream-port`, 0.1.2    | `stale-dns-record`, 0.1.2            |
| Learn       | `safe-incident-recovery`, 0.1.0 | `failover-and-data-integrity`, 0.1.0 |
| Code Review | `proxy-rollout`, 0.1.0          | None published                       |

Source draft status does not remove these separately published records. Retained
metadata does not establish current task availability. The latest ECS inventory
was empty; data resources and GitHub OIDC remain. No new AWS runtime was created
for the SaaS changes.

The retained Cognito pool is currently admin-only after the temporary sign-up
policy was restored. The verified learner identity remains. A new demo deployment
must apply and check the intended self-registration policy before claiming that
Create account works. No pool policy was changed by this read-only check.

## Remaining acceptance

- Rendered desktop/mobile identity, keyboard, font and performance checks.
- Cognito return, demo activation/denial/retry and grant preservation on AWS.
- Existing terminal, telemetry, inline review and playback regression checks.
- Current registry scans, grouped load checks and verified temporary cleanup.
- Measured task lifetimes, selected-provider token rates and session costs.
- A formative learner study and fair cloud/on-premise comparison.

S$12/month remains a proposal with explicit usage, FX, fees, staffing and Free
subsidy assumptions. No payment, recurring subscription, measured profit,
supported concurrency or educational improvement is claimed. Code Review
assistant turns, institution management and real billing remain unimplemented.
