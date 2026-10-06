# Decision register

This register separates product direction from proposed engineering choices. No
technical proposal below implies a team vote or an implemented feature.

## Precedence

1. An explicit later team decision recorded here overrides earlier material.
2. The [PRD](../PRD.md) owns product scope.
3. Normative domain documents own behaviour. JSON Schema and OpenAPI express their
   machine-readable contracts. Conflicts are bugs to fix together.
4. The report is a proposal snapshot, not an evolving implementation specification.
5. Diagrams summarise these documents. They do not settle open choices or replace
   behaviour contracts. Update a shared diagram with its source revision when flows change.

When changing a contract, update the domain document, schema, examples, and validation in
one PR. Do not quietly resolve a conflict by picking a convenient file.

## Change record

| Date | Change |
| --- | --- |
| 21 September 2026 | Baseline: simulated incidents with a deterministic engine, typed actions, and checkpoint replay |
| 25 September 2026 | Preliminary report version 5 adopted as the source of truth. Real per-session containers replace the simulated engine. Session playback and fresh-task retry replace checkpoint replay. Freemium access replaces free Learn with paid practice. Contracts moved to v0.2 |
| 27 September 2026 | Refine v0.2 startup recovery, recording drain, evidence claims, and assistant expiry. Update schemas, examples, and executable reference checks. The submitted report remains a snapshot |
| 2 October 2026 | Correct monitor trust boundaries, terminal input ownership and proposal delivery, receipt lookup order, capture attribution, checkout validation, and pool-capacity claims. Keep the AWS service layout and mark unproven content as draft |
| 4 October 2026 | Implement Wrong upstream port as the first local image increment. Use small PRs and integrate session control before completing the environment subsystem. No Challenge is published by this increment |
| 5 October 2026 | Implement cloud-targeted session admission with local DynamoDB checks. Use one Lambda per action with no direct Lambda-to-Lambda calls. Add disabled CDK definitions. First cloud use will be a temporary integrated test in the NUS account, not an idle development stack |
| 6 October 2026 | Extend session start with saved ECS arguments and idempotent launch. Use the server-generated session ID as the cluster-scoped ECS idempotency token. Create the expiry schedule before `RunTask`. Use a separate expiry Lambda that keeps the active lock until task cleanup is confirmed. Keep both actions disabled until readiness and access are integrated |
| 6 October 2026 | [Provisioning review fixes](provisioning-review.md): create recovery and timeout callbacks before launch, keep monitor secrets out of ECS arguments, persist launch rejections for replay, and align content admission with IAM task families |
| 6 October 2026 | Correct the review-fix regressions: normalize Fargate's capacity message, retry S3 conditional-write conflicts once, and restore short cleanup retries for known tasks while retaining the recovery callback |
| 6 October 2026 | [First monitor measurement increment](monitor-measurement.md): use bounded timestamped request records, direct exact aggregation, real checkout validation, and separate-container tests. Keep network control, resource stats, captures, and cloud readiness separate |

## Product decisions

| ID | Decision | Source |
| --- | --- | --- |
| D01 | Learn, Challenges, and Code Review, with Challenges the main focus | Report v5 |
| D02 | Freemium across all modes: Free, Pro, and per-seat Institutional. No fixed prices | Report v5, replaces free Learn and paid practice |
| D03 | Single-player Challenges run real services with one planted misconfiguration in an isolated per-session container | Report v5, replaces the simulated engine |
| D04 | No fixed action list. Learners use a root shell. Validators define recovery | Report v5, replaces typed operations |
| D05 | Gateway and monitor record the session outside the learner's reach | Report v5 |
| D06 | Session playback after the debrief, and retries in a fresh task that never change the first attempt | Report v5, replaces checkpoint replay |
| D07 | Easy, Medium, Hard tiers and available-language filters | Earlier decision, kept |
| D08 | Optional assistant explains and may propose a command that runs only after confirmation | Report v5 |
| D09 | 5 to 10 participant formative pilot, AI off | Report v5 |
| D10 | Google Wheel of Misfortune is the educational reference | Earlier decision, kept |
| D11 | No multiplayer, MCP, generated content, or enterprise features | Earlier decision, kept |

## Proposed engineering defaults

Contributors may refine these with evidence, provided product behaviour is preserved.

| ID | Working default | Rationale and validation |
| --- | --- | --- |
| T01 | TypeScript on Node 22 for the API, gateway, and contracts | Shared types and native Lambda streaming. Check the runtime before deployment |
| T02 | Static browser app, frontend framework open | Static hosting on S3 and CloudFront |
| T03 | Route 53, CloudFront, S3, Cognito, Regional REST API, Lambda, DynamoDB, ECS on Fargate, ALB, EventBridge Scheduler, CloudWatch | Report deployment. Prove isolation, WebSockets, and streaming early |
| T04 | JSON Schema 2020-12 and OpenAPI 3.1 contracts | Validated by `npm run check` |
| T05 | Two containers per task, with authenticated encrypted monitor traffic and restricted capabilities | Separates files and processes, not networking. Prove secret protection and failure handling on Fargate |
| T06 | Gateway is the only component that reaches environment tasks. Lambda stays outside the VPC | Keeps tasks private without a NAT gateway |
| T07 | Raw score components first | Weights are undecided. Do not ship an invented combined score |
| T08 | Server-side plan grants in the prototype | Proves entitlement checks without billing integration |
| T09 | One active session per learner | Bounds cost and Fargate quota use |
| T10 | Time limit starts at readiness. Pro extension is a platform setting | Start-up latency is not charged to the learner |
| T11 | Opaque single-use terminal tickets stored as hashes | No shared signing key between API and gateway. Tickets stay out of URLs |
| T12 | Shell integration markers for command boundaries, input lines as fallback | Standard terminal technique. Tampering affects only the learner's own events |
| T13 | Command and saved-output patterns for observed evidence. Trap timing indicates possible harm only | Avoid credit for path mentions or empty editor output. Monitor measurements own recovery and impact |
| T14 | Separate the session outcome from recording completion, with a bounded gateway drain before task stop | Avoid losing buffered evidence. Incomplete recording has no numeric score. Validate disconnect, timeout, and late-writer paths |
| T15 | Fixed assistant-turn expiry with conditional interruption and completion | A crashed worker cannot block the conversation or overwrite a later turn. Same request ID never recalls the provider |
| T16 | One terminal input generation, enforced at the terminal server, separate from recorder ownership | A reconnect fences stale input even across gateway copies. Proposals need a verified empty prompt and explicit delivery status |
| T17 | Resolve owned request receipts before new-operation version and plan checks | A lost response remains recoverable after publication or plan expiry. Saved grants cover the existing attempt and result, not new paid content |
| T18 | A bounded checkout validator verifies creation and a follow-up read | HTTP status alone cannot prove a completed checkout. Start with this fixed operation, not a general test language |
| T19 | Timestamp capture intervals and qualify causal claims | Later commands and background processes can change files before a capture. Do not pause the shell to imply exact per-command snapshots |
| T20 | Wrong upstream port is the first local reference image | Small real stack with an observable fault, repair, and restart trap. Other scenario drafts remain unvalidated |
| T21 | Debian 12, Flask with Gunicorn, PostgreSQL 15, and Supervisor for this image | Distribution packages avoid a second package installer. The manifest already uses Gunicorn. Supervisor supports the required service controls without systemd or privileged mode. This does not choose the monitor language |
| T22 | Check initial service listeners before learner access, not as ongoing container health | Stops and valid alternative repairs can change the listeners. Local tests use an explicit startup command. Do not turn these checks into Docker or ECS liveness checks |
| T23 | One deployed Lambda per action, with a separate role, bundle, timeout, and concurrency limit | Explicit user requirement. Share code, not synchronous Lambda calls. Keep learner state external. Bound retries, validate input, and test failures |
| T24 | CDK TypeScript definitions with local synthesis, then temporary AWS integration runs | Fits the backend language. No deployment, bootstrap, or personal AWS profile use in local checks. School permissions and budget still need verification |
| T25 | DynamoDB adapter from the start, tested against DynamoDB Local | Exercises transactions and conflicts without a second local platform runtime. Does not prove AWS IAM or distributed-service behaviour |

T23 follows the action boundary and client-reuse guidance in
[AWS Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
and the warnings about direct function chains in
[AWS event-driven architecture guidance](https://docs.aws.amazon.com/lambda/latest/operatorguide/functions-calling-functions.html).
These are engineering rules, not a reason to add a queue or workflow service without a need.

## Open choices and decision timing

| Choice | Needed by | Who resolves it |
| --- | --- | --- |
| Database draft workload, worker concurrency, and connection budget | Before publishing that Challenge | Content contributors, with measured fault, fix, and trap evidence |
| Terminal server in the challenge image | Terminal and gateway integration | Environment contributors |
| Frontend framework, terminal emulator, and chart library | First interface task | Frontend contributors |
| AWS Region, domain, and school-account deployment permissions | First deployment spike | Cloud contributors |
| LLM provider, model, and limits | First assistant task | LLM contributors, using benchmark evidence |
| Scoring weights and investigation-effort measure | Before learner study | Content and evaluation contributors |
| Pro time-limit extension and Free content set | Before pilot | Team |
| Exercise counts and language coverage | Content planning, frozen before pilot | Team |
| Warm pool size and schedule | After first performance tests | Cloud contributors |
| Retention period for recordings, sessions, and conversations | Before external pilot | Team and evaluation owner |
| Open-source licence | Before accepting outside reuse | Team |
| Real billing, prices, and institutional operations | Beyond the prototype unless approved | Team |

## Recording a change

Use [the ADR template](template.md) for a significant technical change. Routine decisions
can be a short register update.
