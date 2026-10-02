# OpsReplay

Learn production failures by investigating them.

OpsReplay is a production-engineering learning platform for computer science students and
junior software, DevOps, platform, and site reliability engineers. In a Challenge, the
learner gets a root shell in a live, deliberately misconfigured environment running real
services in an isolated cloud container. They diagnose with production tools, repair real
configuration files, and see real consequences. Afterwards they can play back the session
beside the logs and metrics, or retry in a fresh environment.

**Status: specification baseline.** The [preliminary report, version 5](docs/reports/preliminary/README.md)
defines the accepted product direction. The [decision register](docs/decisions/README.md)
defines precedence for later refinements. This repository contains design documents, versioned contracts,
validation tools, and three synthetic draft Challenge manifests. No Challenge image,
monitor, gateway, application, or cloud deployment exists. Contract checks do not prove
that anything works.

## Start here

1. Read the [PRD](docs/PRD.md) for scope and acceptance criteria.
2. Read the [decision register](docs/decisions/README.md) for decisions, proposed
   defaults, and open choices. Do not infer team approval from a detailed specification.
3. Read the [architecture](docs/architecture.md) and [Challenge environments](docs/challenges.md).
4. Use the [implementation plan](docs/implementation-plan.md) to pick a bounded task.
5. Follow [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
   Read [SECURITY.md](SECURITY.md) before handling credentials, environments, or learner data.

## Product

| Mode | Purpose |
| --- | --- |
| Learn | Curated documented failures: category, summary, lessons, official report link, related exercises |
| Challenges | Investigate and recover a live misconfigured environment, then debrief, play back, or retry |
| Code Review | Flag risky lines in a diff and compare them with reference findings |

Challenges are the main development focus. Challenges and Code Review use Easy, Medium,
and Hard tiers. Access is freemium in every mode: Free covers a limited set, mostly Easy,
including full Challenge debriefs and playback. Pro unlocks the expanded set, and
Institutional licenses Pro per seat. The prototype uses server-side plan grants, not a
payment processor.

Validators decide recovery, and the monitor measures impact outside the learner's reach.
The optional assistant explains and may propose a command that runs only after the
learner confirms it. Every mode works without it.

## Check this repository

Requirements: Node.js 22.19 or later within the Node 22 release line and npm 10+. The
[.nvmrc](.nvmrc) selects the development Node version. No AWS account, Docker, or LLM key
is needed for these checks.

```sh
npm ci
npm run check
```

Checks validate the JSON Schema and OpenAPI contracts, contract examples, Challenge
manifests and review bundles, trap and evidence patterns, the reference debrief and
review-matching rules against the examples, local documentation links, and style.
Regression tests also exercise reference models for interrupted startup, recording
drain, evidence matching, and assistant expiry. These models do not call AWS, run
containers, or use an LLM provider. Additional models check receipt lookup order,
terminal input generations, uncertain proposal delivery, and checkout responses through
an injected transport. They do not test a real PTY, TLS, or database. There is no
application start command yet.

## Repository map

```text
apps/
  web/                  Static browser application
  api/                  Lambda handlers, lifecycle, and finaliser
  gateway/              WebSocket gateway service on ECS
  monitor/              Monitor container beside each Challenge
packages/
  contracts/            JSON Schema, OpenAPI, examples
content/
  challenges/           Challenge manifests, later with image build contexts
  learn/                Learn entries
  reviews/              Code Review bundles and private findings
infra/                  Deployment boundary and first spike
docs/                   Product, design, data, delivery, and decisions
scripts/                Repository validation
```

Never import Challenge manifests, review findings, or other private content into the
frontend or the assistant's context. Content is visible in this public repository, so
the prototype cannot promise exam secrecy. Runtime APIs must still prevent accidental
answer leakage.

## Specifications

| Document | Owns |
| --- | --- |
| [PRD](docs/PRD.md) | Product scope and acceptance criteria |
| [Architecture](docs/architecture.md) | Components, AWS deployment, isolation, trade-offs |
| [Challenge environments](docs/challenges.md) | Tasks, monitor, recording, scoring, debrief, playback |
| [Data model](docs/data-model.md) | Records, keys, conditional writes, retention |
| [API](docs/api.md) | REST behaviour, gateway protocol, errors |
| [Design](docs/design.md) | Learner flows and frontend behaviour |
| [LLM integration](docs/llm.md) | Context, proposals, limits, provider failure |
| [Content guide](docs/content-authoring.md) | Images, manifests, Learn, reviews, release checks |
| [Evaluation](docs/evaluation.md) | System, LLM, learner, and cost evaluation |
| [Implementation plan](docs/implementation-plan.md) | Work packages and dates |
| [Decision register](docs/decisions/README.md) | Decision status and change process |

Google's [Wheel of Misfortune](https://sre.google/workbook/postmortem-culture/) is the
educational reference for reenacting previous incidents. OpsReplay adapts it for
individual browser-based practice. This is not a claim that incident training or its
software implementation is new.

## Team and project

NUS CS5224, Group 26: Lee Hao Zhe, Neeraj Kumbar, Neo Qi Hao, Poh Yu Wen, See Yang Zhi,
and Teo Kai Xiang.

No open-source licence has been selected. Public visibility alone does not grant reuse
rights. Do not add a licence without a team decision.
