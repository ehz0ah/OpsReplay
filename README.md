# OpsReplay

Learn production failures by investigating them.

OpsReplay is a production-engineering learning platform for students and junior
engineers. A learner enters an isolated, deliberately misconfigured environment,
investigates it with real tools, repairs the fault, and reviews a deterministic debrief
and session playback.

## Current status

**Current phase:** the backend path for one reference Challenge is implemented. A
disposable AWS checkpoint exercised one operator-seeded session from CloudFront terminal
ingress through stored results on 15 October 2026. It was then removed. The learner web
application and normal authenticated entry path are the next product milestone.

| Area                                   | Status                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Wrong upstream port Challenge          | Runnable and tested locally and on AWS                                              |
| Monitor and validators                 | Implemented with authenticated control, metrics, captures, and recovery checks      |
| Gateway                                | Implemented with terminal relay, live telemetry, recording, and reconnect handling  |
| Session backend                        | Implemented for start, status, tickets, hints, end, lifecycle recovery, and cleanup |
| Results                                | Deterministic debrief, timeline, playback export, and retry support are implemented |
| AWS infrastructure                     | One operator-seeded terminal-to-result checkpoint passed; no runtime is deployed    |
| Web application                        | Not implemented                                                                     |
| Catalogue and account bootstrap APIs   | Implemented locally; AWS integration pending                                        |
| Learn, Code Review, and assistant APIs | Not implemented                                                                     |
| Additional Challenges and evaluation   | Planned after the first learner-facing flow                                         |

See the [15 October AWS checkpoint report](docs/checkpoints/2026-10-15-terminal.md)
for the tested commit, setup, results, limitations, and teardown state. It did not test
browser sign-in, API Gateway authentication, or session start.

## Product scope

| Mode        | Learner activity                                                          | Current priority |
| ----------- | ------------------------------------------------------------------------- | ---------------- |
| Challenges  | Diagnose and repair a live failure, then review the evidence and playback | Primary MVP path |
| Learn       | Read curated incident explanations and related exercises                  | Planned          |
| Code Review | Find risky changes and compare them with reviewed findings                | Planned          |

Free access will include complete introductory experiences. Paid individual and
institutional access will add content and progress features. Exact prices are not set.

## How a Challenge works

```text
Sign in -> start isolated task -> investigate terminal and telemetry
        -> repair the fault -> validators confirm recovery
        -> debrief -> playback or retry in a fresh task
```

The Challenge, monitor, and Gateway run as separate containers. The learner receives a
root shell only inside the Challenge container. The monitor decides recovery from
external checks. The deterministic backend owns session state, consequences, evidence,
and scoring. The planned assistant can explain or propose a command, but it does not own
scenario truth and is not required to complete a Challenge.

## Repository checks

Base requirements:

- Node.js 22.19 or later in the Node 22 release line
- npm 10 or later

The `.nvmrc` file selects the development Node version. Docker is also required for image
tests and DynamoDB Local integration tests.

```sh
npm ci
npm run quality
npm run check
```

These commands do not use AWS or an LLM provider. Component checks are separate because
some build images or run longer integration tests:

| Component      | Commands                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Challenge      | `npm run challenge:build && npm run challenge:test`                                                 |
| Monitor        | `npm run monitor:test && npm run monitor:image:build && npm run monitor:image:test`                 |
| Gateway        | `npm run gateway:test && npm run gateway:runtime:image:build && npm run gateway:runtime:image:test` |
| API            | `npm run api:test`                                                                                  |
| Content        | `npm run content:test`                                                                              |
| Infrastructure | `npm run infra:test && npm run infra:synth`                                                         |

There is no browser application start command yet. Local checks do not prove AWS IAM,
Cognito, Fargate, or network behaviour.

## Repository map

```text
apps/api/          Lambda actions and lifecycle orchestration
apps/gateway/      Terminal, telemetry, and recording Gateway
apps/monitor/      Independent measurements and recovery validation
apps/web/          Planned static browser application
content/           Challenge, Learn, and Code Review source material
packages/          Contracts, content validation, and shared session logic
infra/             CDK stacks and infrastructure tests
docs/              Product, architecture, operations, and decision records
```

Start with the [documentation index](docs/README.md). Contributors must also read
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Security and content boundary

Never import private Challenge manifests, validators, traps, or review findings into the
browser or assistant context. Public responses use explicit projections and server-side
ownership checks. Challenge tasks have no task IAM role and no internet route.

The repository is public, so its current content cannot provide exam secrecy. Runtime
controls still prevent accidental answer leakage between learners.

## Project

OpsReplay is an NUS CS5224 project by Lee Hao Zhe, Neeraj Kumbar, Neo Qi Hao, Poh Yu Wen,
See Yang Zhi, and Teo Kai Xiang.

Google SRE's
[Wheel of Misfortune](https://sre.google/workbook/postmortem-culture/) is the educational
reference for replaying incidents. OpsReplay does not claim that incident simulation is
a new category.

No open-source licence has been selected. Public access to this repository does not grant
permission to reuse its contents.
