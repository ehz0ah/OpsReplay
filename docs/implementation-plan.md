# Implementation plan

Status: current work plan for six contributors. No assignments are implied. Agree owners
before overlapping work. Work packages are responsibility groups, not a waterfall.

An operator-seeded terminal-to-result path for the first Challenge passed a disposable
AWS checkpoint on 15 October 2026. It did not exercise Cognito, API Gateway, or session
start. The next product milestone is an assistant-free browser flow. It needs the missing
catalogue and account bootstrap reads, then sign-in, Challenge start, terminal and live
telemetry, hints, outcome, debrief, playback, and retry. A later AWS checkpoint must use
the browser rather than operator scripts. Retained AWS data ownership must be explicit
before that deployment. See the [checkpoint report](checkpoints/2026-10-15-terminal.md).

## Work packages

| ID  | State                      | Work                                                                                      | Completion evidence                                                                                 |
| --- | -------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| I01 | Implemented                | Reference Challenge image, planted fault, shell markers, and terminal server              | Local image tests and AWS checkpoint                                                                |
| I02 | Implemented                | Monitor traffic, validators, probes, captures, and authenticated control                  | Local image tests and AWS checkpoint                                                                |
| I03 | Core implemented           | Gateway tickets, terminal relay, live telemetry, recording, and heartbeats                | Local reconnect and recording tests; one AWS session. Assistant proposal execution remains with I08 |
| I04 | Implemented                | Start, readiness, end, time limit, sweep, finalisation, and reconciliation                | Failure-injection tests and one operator-seeded AWS lifecycle                                       |
| I05 | First checkpoint complete  | VPC, endpoints, ECS, digest-pinned tasks, Cognito, CloudFront, internal ALB, and teardown | [15 October checkpoint](checkpoints/2026-10-15-terminal.md). Browser, REST entry, and load remain   |
| I06 | Next                       | Browser terminal, dashboard, timeline, hints, and outcome                                 | Alert-to-outcome flow without the assistant                                                         |
| I07 | Backend implemented        | Debrief, score components, playback, and retry                                            | Local contract tests and local handler reads against AWS data. Browser presentation remains         |
| I08 | Not started                | Optional assistant and confirmed proposals                                                | Benchmark, leakage tests, and provider-failure recovery                                             |
| I09 | Catalogue and account next | Catalogue, account, and plans; later Learn and Code Review                                | Free and Pro access enforcement and matching tests                                                  |
| I10 | Not started                | Additional validated Challenges                                                           | Scenario evidence and independent content review                                                    |
| I11 | Not started                | System and user evaluation, cost comparison, demo, and report                             | Reproducible measurements and pilot results                                                         |

The browser workspace and missing catalogue and account reads can proceed in parallel
against the current public contracts. Shared contract changes are coordinated, not
redefined in each module.

## First milestone

The backend is implemented, and the checkpoint covered the cloud runtime after operator
setup. I06 must make the same path usable through the browser before the milestone is
complete:

```text
Start -> task ready -> alert -> terminal investigation -> configuration fix
      -> validators sustained -> debrief -> playback -> retry in a fresh task
```

For the reference Challenge, demonstrate at least one trap with its real effect, such as
a restart with a broken configuration taking the proxy down. This matters more than more
Challenges or a polished assistant.

AWS is the deployment target. Use Lambda handlers and the real DynamoDB adapter from
the start. Test locally with DynamoDB Local, image tests, and bounded fault injection.
Do not build a separate local platform runtime. Local tests cannot establish IAM,
Fargate, or cloud network correctness. Add CDK definitions with each component, then
deploy, test, and tear down the integrated flow. Do not keep an idle development stack.

## Planned dates

| Period in 2026             | Target                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| 21 to 28 September         | Finalise the reference Challenge and submit the preliminary report                          |
| 29 September to 11 October | Build the reference image, monitor, validators, and session recording, and test them on AWS |
| 12 to 25 October           | Integrate interface, dashboard, persistence, playback, and LLM. Add Learn and Code Review   |
| 26 October to 5 November   | Validate additional Challenges and run system tests and the learner study                   |
| 6 to 13 November           | Resolve findings and complete cost analysis, the final report, slides, and demonstration    |

If the core milestone slips, reduce the number of Challenges and visual extras. Do not
replace real environments with scripted output or LLM-generated results to meet a date.
Keep evaluation time and assistant-free play.

## Ready to implement

A task needs a requirement ID, an owner, stable input and output examples, dependencies,
and observable acceptance criteria. Framework, IaC, and monitor language choices can be
made by their owners when the work starts, with a brief rationale in the decision
register.
