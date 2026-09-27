# Decision register

This register separates product direction from proposed engineering choices. No
technical proposal below implies a team vote or an implemented feature.

## Precedence

1. An explicit later team decision recorded here overrides earlier material.
2. The [PRD](../PRD.md) owns product scope.
3. Normative domain documents own behaviour. JSON Schema and OpenAPI express their
   machine-readable contracts. Conflicts are bugs to fix together.
4. The report is a proposal snapshot, not an evolving implementation specification.

When changing a contract, update the domain document, schema, examples, and validation in
one PR. Do not quietly resolve a conflict by picking a convenient file.

## Change record

| Date | Change |
| --- | --- |
| 21 September 2026 | Baseline: simulated incidents with a deterministic engine, typed actions, and checkpoint replay |
| 25 September 2026 | Preliminary report version 5 adopted as the source of truth. Real per-session containers replace the simulated engine. Session playback and fresh-task retry replace checkpoint replay. Freemium access replaces free Learn with paid practice. Contracts moved to v0.2 |
| 27 September 2026 | Repair interrupted startup through one lifecycle routine, fixed launch arguments, and deadline reconciliation. The submitted report remains a snapshot |

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
| T05 | Two containers per task: challenge and monitor | Separates measurement from the learner's root shell |
| T06 | Gateway is the only component that reaches environment tasks. Lambda stays outside the VPC | Keeps tasks private without a NAT gateway |
| T07 | Raw score components first | Weights are undecided. Do not ship an invented combined score |
| T08 | Server-side plan grants in the prototype | Proves entitlement checks without billing integration |
| T09 | One active session per learner | Bounds cost and Fargate quota use |
| T10 | Time limit starts at readiness. Pro extension is a platform setting | Start-up latency is not charged to the learner |
| T11 | Opaque single-use terminal tickets stored as hashes | No shared signing key between API and gateway. Tickets stay out of URLs |
| T12 | Shell integration markers for command boundaries, input lines as fallback | Standard terminal technique. Tampering affects only the learner's own events |
| T13 | Case-sensitive regular expressions for evidence and trap detection | Simple and testable. Revisit if authors need more |

## Open choices and decision timing

| Choice | Needed by | Who resolves it |
| --- | --- | --- |
| Reference Challenge, from the three drafts. Working default: Wrong upstream port, the smallest stack | 28 September | Team |
| Monitor implementation language and process supervisor | First image task | Environment contributors |
| Terminal server in the challenge image | First image task | Environment contributors |
| Frontend framework, terminal emulator, and chart library | First interface task | Frontend contributors |
| IaC tool, AWS Region, and domain | First deployment spike | Cloud contributors |
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
