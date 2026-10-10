# Implementation plan

Status: task breakdown for six contributors. No assignments are implied. Agree owners on
the team's task board before overlapping work. The team proves one complete Challenge
first, then a small Learn collection and Code Review set.

The local wrong-upstream-port image now contains its service stack and private interactive
terminal server. Shell markers and the separate recording stream remain open in I01.
Later increments added session-start admission with a Lambda handler, a DynamoDB
transaction, and disabled CDK definitions, followed by ECS launch and
provisioning-timeout cleanup. The first monitor increment added real traffic,
measurements, checkout validation, and outage probes beside the
reference image. A focused increment then added authenticated monitor network control.
The gateway monitor client, bounded recording controller, and durable recording adapters
consume that control API locally. Captures and the running gateway service follow separately. Work
packages are responsibility groups, not a requirement to complete one subsystem before
integrating another.

## Work packages

| ID  | Work                                                                                                                              | Dependencies                               | Completion evidence                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| I01 | Build the reference Challenge image: services under a supervisor, planted fault, service wrappers, shell markers, terminal server | Reference Challenge choice                 | Runs under local Docker with the fault present                                                               |
| I02 | Build the monitor: traffic, checkout validation, probes, timestamped captures, authenticated TLS control port                     | Manifest schema                            | Scenario harness passes the reference fix and each trap locally, 20 repeats. Status-only checkout stubs fail |
| I03 | Build the gateway: tickets, fenced terminal input, dashboard relay, recording, proposal delivery, heartbeats                      | I01, I02, gateway protocol                 | Matching playback, two-gateway reconnect tests, and explicit results for uncertain command delivery          |
| I04 | Implement session lifecycle: start, readiness, end, time limit, sweep, finaliser, reconciliation                                  | Data model, launcher port                  | Duplicate starts launch one task. Every ended session leaves no running task                                 |
| I05 | Prove AWS: VPC and endpoints, ECS cluster, task definitions by digest, gateway behind the ALB, Cognito, Route 53, Scheduler       | Architecture                               | Deployed spike with measured time to a ready terminal, isolation test results, and teardown                  |
| I06 | Build the web workspace: terminal, dashboard with command markers, timeline, hints, outcome                                       | API and gateway examples, then I03 and I04 | Alert to outcome without the assistant                                                                       |
| I07 | Implement debrief, score components, playback, and retry                                                                          | I03, I04                                   | Debrief rules match the fixtures. Retries never change the first attempt                                     |
| I08 | Add the assistant: context builder, streaming turns, proposals, confirmed runs, review debrief support                            | I03, I04, I06                              | Benchmark, leakage tests, provider-failure recovery                                                          |
| I09 | Add Learn build step, Code Review matcher, submissions, and plans                                                                 | Catalogue and review contracts             | Free and Pro access enforced. Matching fixture passes                                                        |
| I10 | Validate additional Challenges                                                                                                    | I01 to I03, authoring guide                | Scenario harness evidence and independent content review                                                     |
| I11 | Run evaluation and cost comparison, prepare demo and report                                                                       | Complete core flow                         | Reproducible system results and pilot report                                                                 |

Frontend exploration, AWS networking, and content research can start while I01 to I03
are built. Shared contract changes are coordinated, not redefined in each module.

## First milestone

Build toward this loop with local component and integration tests, then run the first
complete cloud test in a temporary AWS environment:

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
