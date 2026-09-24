# Implementation plan

Status: task breakdown for six contributors. No assignments are implied. Agree
owners in the team's task board before overlapping work. Implementation starts
with one complete Challenge and a small set of supporting content.

## Work packages

| ID | Work | Dependencies | Completion evidence |
| --- | --- | --- | --- |
| I01 | Implement the pure engine, rule validator, projections, and reference scenario | Baseline contracts | All reference traces and invalid-definition cases pass |
| I02 | Implement local session repository and action coordinator | I01 interface | Atomic commits, receipt retries, version conflicts, ownership, terminal handling |
| I03 | Build Challenge UI against public examples, then integrate | API contract, then I02 | Direct path from alert to debrief with consistent charts/events |
| I04 | Prove AWS identity, DynamoDB transactions, private content, and streaming | Architecture contract | Small deployed integration check with recorded region/runtime |
| I05 | Implement checkpoint creation, child sessions, and comparison | I01–I03 | Parent remains unchanged and repeated suffix matches |
| I06 | Add provider adapter, bounded turns, proposals, and teaching support | I02–I04 | Benchmark, manual-context test, provider-failure recovery |
| I07 | Add free Learn and prepared Code Review with access grants | Catalogue/review contract | Source links, tier/language filters, feedback release and saved submissions |
| I08 | Curate and validate additional scenario content | I01 and authoring guide | Published traces and independent content review |
| I09 | Run evaluation and cost comparison, prepare demo/report | Complete core flow | Reproducible system results and 5–10 participant pilot report |

Frontend exploration, cloud validation, and content research can proceed while the
engine is built. Shared contract changes must be coordinated, not independently
redefined in each module.

## First milestone

Implemented locally: I01, I02, I03, and I05 for the synthetic reference Challenge.
The engine, durable Fastify API, React interface, debrief, and replay comparison
have automated and browser validation. See [local handoff](local-handoff.md) for
exact coverage and limits. This status does not imply AWS or team UI approval.

Prove this loop locally with direct controls:

```text
Alert -> evidence -> mitigation -> changed metrics/events -> recovery/failure
      -> debrief -> checkpoint replay -> outcome comparison
```

For the reference incident, demonstrate that scaling first creates queued work
which persists after rollback. This is more important than adding more scenarios
or a polished chat interface.

## Planned dates

| Period in 2026 | Target |
| --- | --- |
| 21–28 September | Team reviews proposal, confirms first owners, submits preliminary report |
| 29 September–11 October | Engine/reference paths, local API, AWS spike |
| 12–25 October | Integrated UI, replay, debrief, LLM, supporting modes |
| 26 October–5 November | Content checks, load testing, learner pilot |
| 6–13 November | Fix findings, analyse cost, complete final report, slides, and demo |

If the core milestone slips, reduce content breadth and visual extras. Do not
replace deterministic state with LLM-generated outcomes to meet a date. Keep
mandatory evaluation time and direct gameplay.

## Ready to implement

A task needs a requirement ID, an owner, stable input/output examples, dependencies,
and observable acceptance criteria. A task does not need every future platform
choice resolved. Framework and IaC choices can be made by their owners when the
corresponding work starts, with a brief rationale in the decision register.
