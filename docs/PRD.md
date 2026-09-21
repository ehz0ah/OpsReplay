# Product requirements

Status: agreed product direction from the project handoffs and subsequent
discussion. The preliminary report remains under team review. Proposed technical
defaults appear in the [decision register](decisions/README.md).

## Problem and intended outcome

Computer science students and junior engineers have few opportunities to practise
production diagnosis before handling live services. Reading a postmortem does not
require choosing evidence or observing the effects of a recovery decision.

OpsReplay provides individual practice inspired by Google's Wheel of Misfortune.
The learner investigates an evolving incident, applies mitigation, observes
lasting effects, and replays selected decisions to compare outcomes. This is a
proposed educational benefit. It is not proven market uniqueness.

## Audience

Primary users are computer science students and junior software, DevOps, platform,
and site reliability engineers. Institutions may buy access to the same content.
Hiring assessments and enterprise incident ingestion are outside the MVP.

## Requirements and acceptance

| ID | Requirement | Acceptance |
| --- | --- | --- |
| P01 | Free Learn mode | Published summaries and official source links are readable without paid access |
| P02 | Authored practice library | Challenges and Code Review show published difficulty and available content only |
| P03 | Single-player investigation | Starting a Challenge creates an independent session with limited initial evidence |
| P04 | Direct exploration | Learners inspect available metrics, logs, resources, deployments, diffs, and runbooks through typed operations |
| P05 | Reactive simulation | A valid action changes persistent scenario state, later choices, and consistent visible evidence |
| P06 | Causal recovery | At least one scenario demonstrates early rollback, harmful scaling, and temporary relief with different outcomes |
| P07 | Explicit simulated time | Accepted operations and explicit time advances drive time. Browser waiting and AI latency do not |
| P08 | First-class debrief | Terminal attempts show path, evidence, missed clues, action effects, root cause, sources, and recommended recovery |
| P09 | Bounded replay | After an attempt, selected authored checkpoints can start separate practice sessions and compare outcomes without changing the first attempt |
| P10 | Optional conversational support | The LLM uses the same operations and current visible context, including direct actions. Direct play survives provider failure |
| P11 | Bounded teaching support | During play, explanations use visible evidence and released hints. After the attempt, released debrief data can be explained |
| P12 | Code Review | Learners mark risky diff lines and add concerns, then compare with authored findings. The LLM does not grade reasoning |
| P13 | Difficulty and languages | Both practice modes support Easy, Medium, and Hard. Language filters reflect published Code Review content |
| P14 | Ownership and access | Every session and submission belongs to one authenticated learner. The server enforces exercise access and hidden evidence rules |
| P15 | Reliable progress | Committed actions remain available after reconnect. Retries do not repeat effects. Stale requests cannot overwrite newer state |
| P16 | Evaluation | Record correctness, performance, LLM cost and accuracy, and a 5–10 person formative pilot with stated limits |

Requirements apply to the complete MVP. The first implementation slice proves
P03–P09 and P14–P15 for one synthetic scenario before content expansion.

## Scope boundaries

The MVP includes a small curated library, three learning modes, a web interface,
accounts, progress, optional LLM support, and deployment evaluation. Content count,
supported languages, scoring weights, model/provider, and exact prices remain open.

Do not add multiplayer, company postmortem upload, automatic scenario generation,
MCP, autonomous custom agents, real infrastructure failure injection, video/image
generation, a graphical authoring tool, hiring features, or an instructor dashboard.
Do not make a general terminal, arbitrary shell execution, or a full Kubernetes
emulator. Scenario actions operate on a bounded simulation.

## Commercial model

Learn is always free. Paid individual access unlocks authored Challenges and Code
Review, including feedback. Institutional access licenses the same content per
seat. Willingness to pay has not been validated.

The proposed prototype represents access through server-side grants. Payment
collection, renewals, tax, and institutional administration are not required to
prove gameplay. A production billing system needs a separate decision.

## Quality criteria

- The same content/engine version and ordered commands produce the same result.
- Every metric, event, resource state, and debrief agrees with the same state.
- The engine remains usable without AWS and without an LLM.
- Keyboard access, text labels, readable charts, and clear pending/error states
  are part of the interface acceptance criteria.
- No published throughput, learning, or reliability claim precedes measurement.
- Public source code is not an assessment secrecy boundary. Runtime access and
  evidence controls still protect the intended learner experience.

## Success evidence

The first demo must show two different recovery paths from the same checkpoint.
The learner must be able to explain why outcomes differ using visible evidence.
The system evaluation must verify deterministic replay and reliable writes. The
pilot must report usability problems and early learning evidence without treating
its small sample as proof of broad effectiveness.
