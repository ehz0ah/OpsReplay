# OpsReplay

Learn production failures by investigating them.

OpsReplay is a production-engineering learning platform for computer science
students and junior software, DevOps, platform, and site reliability engineers.
Learners investigate simulated incidents, apply recovery actions, and replay
selected decisions to understand their consequences.

**Status: first local Challenge slice implemented.** React/Vite serves the
investigation workspace, debrief, and checkpoint replay. Fastify persists sessions
in SQLite. The engine owns deterministic outcomes and immutable observations.
One original synthetic scenario is included. AWS, LLM integration, Learn, and
Code Review remain planned. The preliminary report is under team review.

## Start here

1. Read the [PRD](docs/PRD.md) for scope and acceptance criteria.
2. Read the [decision register](docs/decisions/README.md) for agreed, proposed, and
   open choices. Do not infer team approval from a detailed specification.
3. Read the [architecture](docs/architecture.md) and [simulation contract](docs/simulation.md).
4. Use the [implementation plan](docs/implementation-plan.md) to pick a bounded task.
5. Follow [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
   Read [SECURITY.md](SECURITY.md) before handling credentials or learner data.

## Product

| Mode | Purpose | Access model |
| --- | --- | --- |
| Learn | Team-written summaries, lessons, and links to official incident sources | Free |
| Challenges | Investigate an evolving incident, mitigate, debrief, and compare replays | Authored paid practice |
| Code Review | Identify risky changes and compare findings with prepared feedback | Authored paid practice |

Challenges are the main development focus. Both practice modes use Easy, Medium,
and Hard tiers. Code Review lists only languages supported by published content.
The business model does not require a payment processor in the first prototype.
Prototype access grants are a proposed implementation choice, recorded in the
[decision register](docs/decisions/README.md).

The engine owns truth, time, consequences, and scoring. Optional LLM support uses
the same validated operations as direct controls. Gameplay must work without it.

## Run locally

Requirements: Node.js 22.19 or later within the Node 22 release line and npm 10+.
The [.nvmrc](.nvmrc) selects the development Node version. No AWS account, Docker,
or LLM key is needed for these checks.

```sh
npm ci
npm run check
npm run dev
```

Open <http://127.0.0.1:5173>, select a local learner, and start the Challenge.
Both processes stop with Ctrl+C. Saved attempts survive restarts in `.local/runtime`.
Use `npm run build` then `npm start` for the built frontend at
<http://127.0.0.1:4173>. These servers are for local use.

Checks cover contracts, documentation links, types, lint, formatting, engine/API
and browser-transport integration tests, and the static web build. Read the
[local handoff](docs/local-handoff.md) for tested paths and remaining work.

See the [development guide](docs/development.md) for workspace boundaries and
commands, and [ADR 001](docs/decisions/001-local-stack.md) for the stack decisions.

## Repository map

```text
apps/
  web/                  Browser application boundary
  api/                  HTTP and LLM orchestration boundary
packages/
  engine/               Cloud-independent simulation boundary
  contracts/            JSON Schema, OpenAPI, tool registry, examples
content/
  challenges/           Server-side scenario definitions and evidence
  learn/                Free authored learning content
  reviews/              Code Review exercises and private findings
infra/                  Deployment boundary and initial validation plan
docs/                   Product, design, data, delivery, and decisions
scripts/                Repository validation
tests/fixtures/         Deterministic specification traces
tests/integration/      Browser transport through the real API and SQLite
```

Never import private scenario definitions or answer keys into the frontend.
Content is visible in this public source repository, so the prototype cannot
promise exam secrecy. Runtime APIs must still prevent accidental answer leakage.

## Specifications

| Document | Owns |
| --- | --- |
| [PRD](docs/PRD.md) | Product scope and acceptance criteria |
| [Architecture](docs/architecture.md) | Runtime boundaries and deployment trade-offs |
| [Data model](docs/data-model.md) | Records, ownership, persistence, concurrency |
| [Simulation](docs/simulation.md) | Time, transitions, metrics, replay, cost |
| [API](docs/api.md) | Endpoint behaviour and errors |
| [Design](docs/design.md) | Learner flows and frontend behaviour |
| [LLM integration](docs/llm.md) | Context, tools, proposals, provider failure |
| [Content guide](docs/content-authoring.md) | Evidence, provenance, and release checks |
| [Evaluation](docs/evaluation.md) | System and learner evaluation |
| [Implementation plan](docs/implementation-plan.md) | Work packages and completion criteria |
| [Decision register](docs/decisions/README.md) | Decision status and change process |

Google's [Wheel of Misfortune](https://sre.google/workbook/postmortem-culture/)
provides the educational reference for reenacting previous incidents. OpsReplay
adapts this method for individual browser-based practice. This is not a claim
that incident training or its software implementation is new.

The [preliminary report snapshot](docs/reports/preliminary/README.md) records the
proposal sent for team review. Repository specifications may become more precise
without silently changing the agreed product scope.

## Team and project

NUS CS5224, Group 26: Lee Hao Zhe, Neeraj Kumbar, Neo Qi Hao, Poh Yu Wen,
See Yang Zhi, and Teo Kai Xiang.

No open-source licence has been selected. Public visibility alone does not grant
reuse rights. Do not add a licence without a team decision.
