# Documentation

This index separates current product contracts from historical decisions and operational
procedures.

## Start here

1. [Product requirements](PRD.md) defines product scope and acceptance criteria.
2. [Architecture](architecture.md) defines service boundaries and AWS deployment.
3. [Interface design](design.md) defines learner-facing behaviour.
4. [Implementation plan](implementation-plan.md) shows completed and remaining work.

The [preliminary report](reports/preliminary/README.md) is a submitted project snapshot.
Later decisions and implemented contracts take precedence.

## Engineering contracts

| Document                                  | Responsibility                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| [Challenge environments](challenges.md)   | Isolation, monitoring, recording, scoring, debrief, and playback        |
| [API](api.md)                             | REST routes, Gateway protocol, errors, and limits                       |
| [Data model](data-model.md)               | DynamoDB and S3 records, ownership, consistency, and retention          |
| [LLM integration](llm.md)                 | Planned assistant boundaries, context, failure handling, and evaluation |
| [Content authoring](content-authoring.md) | Challenge, Learn, and Code Review publication rules                     |

Machine-readable contracts are under `packages/contracts/`. A contract change must update
the normative document, schema, examples, and validation together.

[Browser deployment](browser-deployment.md) covers static hosting, exact connection
origins, identity setup and signed-recording CORS.

## Delivery and evaluation

| Document                                                               | Responsibility                             |
| ---------------------------------------------------------------------- | ------------------------------------------ |
| [Evaluation](evaluation.md)                                            | System, learner, LLM, and cost evaluation  |
| [AWS checkpoint runbook](runbooks/aws-checkpoint-activation.md)        | Safe activation, drain, and teardown       |
| [17 October AWS browser checkpoint](checkpoints/2026-10-17-browser.md) | Verified browser flow, findings and limits |
| [Decision register](decisions/README.md)                               | Accepted decisions and later refinements   |

Decision files preserve the reason and scope of an increment. Their historical status
statements are not the current project status. Use this index, the root README, and the
implementation plan for current status.

The [formative pilot package](evaluation/pilot/README.md) supplies consent, static
comparison cases, assignments, learning questions, manual scoring and usability forms.
Completed participant files remain private.
