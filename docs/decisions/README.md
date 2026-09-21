# Decision register

This register separates agreed product direction from proposed engineering choices.
The baseline is dated 21 September 2026. No technical proposal below implies a
team vote or an implemented feature.

## Precedence

1. An explicit later team decision recorded here overrides earlier material.
2. [PRD](../PRD.md) owns product scope.
3. Normative domain documents own behaviour. JSON Schema and OpenAPI express
   their machine-readable contracts. Conflicts are bugs to fix together.
4. The report is a proposal snapshot, not a separate evolving implementation spec.

When changing a contract, update the domain document, schema, examples, and
validation in one PR. Do not quietly resolve a conflict by picking a convenient file.

## Agreed product decisions

| ID | Decision | Source |
| --- | --- | --- |
| D01 | Learn, Challenges, and Code Review, with Challenges the main focus | Handoff v2 and later discussion |
| D02 | Free Learn and authored paid practice, no fixed prices | User correction |
| D03 | Single-player deterministic simulation with lasting effects | Handoffs and replay direction |
| D04 | Direct UI and optional LLM share validated operations | Handoffs |
| D05 | Engine owns truth, time, scoring, and transitions | Handoffs |
| D06 | Replay selected checkpoints after an attempt, preserving first-attempt results | Accepted replay direction |
| D07 | Easy, Medium, Hard tiers and available-language filters | User correction |
| D08 | 5–10 participant formative pilot | User correction |
| D09 | Google Wheel of Misfortune is the report's educational reference | Latest report revision |
| D10 | No deferred enterprise, multiplayer, MCP, or generated-content features | Scope handoffs |

## Proposed engineering defaults

These make the first implementation task concrete. Contributors may refine them
with evidence, provided agreed product behaviour is preserved.

| ID | Working default | Rationale and validation |
| --- | --- | --- |
| T01 | TypeScript for API, engine, and contracts, Node 22 for tooling | Shared operation types and native Lambda streaming support. Runtime upgrade must be checked before deployment |
| T02 | Static browser app, frontend framework open | S3 hosting needs static output. The frontend owner can choose the framework without changing contracts |
| T03 | Regional REST API, separate gameplay/LLM Lambda handlers, DynamoDB, private S3, Cognito, CloudFront, CloudWatch | Report proposal. Prove regional/runtime streaming, identity, and transactional persistence early |
| T04 | JSON Schema 2020-12 and OpenAPI 3.1 as language-neutral contracts | This baseline validates them. Choose generated or handwritten runtime types in the first API PR |
| T05 | Small declarative state/rule language, integer arithmetic | Enables authored JSON without `eval`. See simulation specification. Prototype complexity before expanding operators |
| T06 | Action-cost time steps, explicit advance action, no wall-clock progression | Fair replay, no continuously running session worker |
| T07 | Raw cost and outcome components first | Scoring weights are undecided. Do not ship an invented 0–100 formula |
| T08 | Server-side access grants in prototype | Proves paid-content access control without adding billing integration |
| T09 | One hosted API with modular code, not microservices | Separate Lambda handlers provide capacity isolation without service sprawl |
| T10 | LLM proposes mitigation, learner confirms through the action endpoint | Prevents intent errors from making unconfirmed changes |

## Open choices and decision timing

| Choice | Needed by | Who resolves it |
| --- | --- | --- |
| Frontend framework and chart library | First interface task | Frontend contributors |
| IaC tool and AWS region | First deployment spike | Cloud contributors |
| LLM provider/model and limits | First conversational task | LLM contributors using benchmark evidence |
| Scoring formula | Before learner study | Content and evaluation contributors |
| Scenario count and language coverage | Content planning, then freeze before pilot | Team based on capacity |
| Open-source licence | Before accepting outside reuse/contributions | Team |
| Retention period for account/session/conversation data | Before external pilot | Team and evaluation owner |
| Real billing, prices, and institutional operations | Beyond core prototype unless explicitly approved | Team |

## Recording a change

Use [the ADR template](template.md) for a significant technical change. Record
context, selected option, alternatives, consequences, status, and verification.
Routine decisions can be a short register update. Do not create a new process
layer for every small refactor.
