# Implementation plan

Status: current work plan for six contributors. No assignments are implied. Agree owners
before overlapping work. Work packages are responsibility groups, not a waterfall.

The reference Challenge passed a disposable AWS browser checkpoint on 17 October 2026. One learner completed a recovery and a fresh retry through Cognito, API
Gateway, terminal, debrief and S3 playback. All temporary runtime resources were
removed. The durable stack retains data resources. See the
[checkpoint report](checkpoints/2026-10-17-browser.md) for findings and untested cases.

The [23 October learner checkpoint](checkpoints/2026-10-23-learner-experience.md)
adds verified-email sign-up, inline review drafts/results, the DNS Challenge and
one confirmed assistant proposal. The [26 October status](checkpoints/2026-10-26-saas-local.md)
records locally checked SaaS changes and the remaining browser, AWS and evaluation
gates. No runtime is currently deployed.

## Work packages

| ID  | State                           | Work                                                                                      | Completion evidence                                                                                         |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| I01 | Implemented                     | Reference Challenge image, planted fault, shell markers, and terminal server              | Local image tests and AWS checkpoint                                                                        |
| I02 | Implemented                     | Monitor traffic, validators, probes, captures, and authenticated control                  | Local image tests and AWS checkpoint                                                                        |
| I03 | Core implemented                | Gateway tickets, terminal relay, live telemetry, recording, and heartbeats                | Local tests and AWS browser resume/recording; assistant proposals remain with I08                           |
| I04 | Implemented                     | Start, readiness, end, time limit, sweep, finalisation, and reconciliation                | Local failure-injection tests and two browser-started AWS attempts                                          |
| I05 | Browser checkpoint complete     | VPC, endpoints, ECS, digest-pinned tasks, Cognito, CloudFront, internal ALB, and teardown | [17 October checkpoint](checkpoints/2026-10-17-browser.md). Load and remaining failure cases are unverified |
| I06 | Browser checked on AWS          | Browser terminal, dashboard, timeline, hints, and outcome                                 | Real alert-to-outcome flow; command matching and telemetry follow-ups remain                                |
| I07 | Browser checked on AWS          | Debrief, score components, playback, and retry                                            | Real debrief, recorded terminal, metrics/captures and fresh retry; expiry/pagination limits remain          |
| I08 | Challenge assistant implemented | Optional assistant and confirmed proposals; Code Review assistant remains planned         | Local boundary/recovery tests and one AWS proposal; model benchmark remains pending                         |
| I09 | Learner workflows implemented   | Catalogue, account, plans, Learn, inline Code Review and History                          | Local access tests and 23 October browser checkpoint; new SaaS/upgrade cloud checks remain pending          |
| I10 | DNS Challenge implemented       | Two implemented Challenges; connection-exhaustion draft remains blocked                   | 23 October DNS browser checkpoint and preliminary local repeats; full repeats remain pending                |
| I11 | Evaluation in progress          | System and user evaluation, cost comparison, demo, and report                             | Tools and pilot materials exist; full results, measured costs and participant study remain pending          |

The browser and bootstrap reads share the public contracts. AWS verification remains
separate from local implementation. Shared contract changes are coordinated, not
redefined in each module.

## First milestone

The first integrated browser milestone passed on AWS for one reference Challenge:

```text
Start -> task ready -> alert -> terminal investigation -> configuration fix
      -> validators sustained -> debrief -> playback -> retry in a fresh task
```

Later changes address compound-command evidence and reduce dashboards to measured
signals. The current version is still subject to the full evaluation gates.
Before the pilot, verify uncertain start, cross-owner access, expiry and playback
continuation on the deployed revision. A normal browser checkpoint is not proof
of all failure paths or classroom capacity.

The checkpoint demonstrated the required trap: restarting nginx with invalid
configuration stopped the proxy. Keep this real consequence in the demonstration.

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

Before a classroom pilot, measure simultaneous catalogue/account loads and tune their
shared API Gateway burst/rate limits. The current read defaults are burst 4 and rate 2
requests per second for each route, across all callers. This is a capacity follow-up
from PR #75, not a per-user quota or measured classroom limit.
