# First local Challenge handoff

This slice implements PRD P03–P09 and P14–P15 for one original synthetic scenario.
It provides direct investigation, lasting action effects, terminal debrief, and
checkpoint replay. It is ready for local team development and review. It is not
a hosted service or evidence of learning effectiveness.

## Run and inspect

Use Node 22, then `npm ci`, `npm run check`, and `npm run dev`. Open
<http://127.0.0.1:5173>. Select Local learner. The
[development guide](development.md) covers built preview, storage, and recovery.

The UI uses a light investigation workspace with evidence tabs, a history panel,
and separate mitigation controls. On narrow screens, switch between Evidence and
History. Metrics include sample tables and action markers. Earlier observations
retain their original values and timestamps. No LLM key is needed.

## Reference outcomes

Start a new attempt for each path. One tick is one simulated minute. Values below
come from the engine fixtures and tests, not wall-clock timing.

| Path | Expected result | Final tick | Impact units |
| --- | --- | --- | --- |
| Roll back immediately | Resolved | 1 | 0 |
| Scale to six, roll back, advance three ticks | Resolved after queued work drains | 6 | 200 |
| Restart, advance three ticks | Active, leak returns | 5 | 97 |
| Advance ten ticks | Stops at failure | 6 | 420 |

For an investigation path, inspect database connections, deployments, and the
diff before rollback. Review the debrief, replay from the start, and compare an
earlier rollback. The first attempt must remain unchanged. Replays are labelled
as informed practice. Scores use raw time and impact. No 0–100 formula is invented.

## Validation evidence

`npm run check` covers 99 tests across contracts, engine, API, and browser
transport. It also checks schema/type drift, documentation links, strict types,
lint, formatting, and the static frontend build. The API tests use real temporary
SQLite files, including concurrent connections and injected transaction failures.

Browser checks with Ego covered:

- Investigation through metrics, logs, topology, runbook, deployment, and diff.
- Success, failure, early exit, debrief, checkpoint replay, and comparison.
- Lost response after a committed mitigation, reload, and retry of the same ID.
- Stale confirmation after a competing action, with no stale write applied.
- Learner switching, isolated attempts, and distinct earlier metric observations.
- Keyboard modal focus and axe WCAG A/AA checks on workspace, dialog, and debrief.
- Built frontend with real API, deep-link reload, and preserved data after restart.
- Combined development startup with an API port override and process shutdown.

Verified on macOS with Node 22.23.1. The measured narrow browser viewport was
355 CSS pixels, with no page overflow. The desktop viewport was 1422 CSS pixels.
Browser emulation scaled the requested sizes. Exact 320-pixel coverage and other
browsers remain unverified. The clean install reported no known vulnerabilities.

The automated transport tests also hold an old response until after a newer cache
update, and recover observations through paginated history. Browser checks are
recorded manual evidence. They are not an unattended browser regression suite.

## Where to contribute

| Area | Entry points | Preserve |
| --- | --- | --- |
| Scenario behavior | `packages/engine/src`, `docs/simulation.md` | Pure transitions, old-version replay, integer costs |
| API and storage | `apps/api/src`, `docs/data-model.md` | Ownership, version checks, atomic receipts |
| Interface | `apps/web/src`, `docs/design.md` | Public DTOs, request recovery, accessible controls |
| Contracts | `packages/contracts`, `docs/api.md` | Schema, OpenAPI, generated types, examples together |
| Content | `content/challenges`, `docs/content-authoring.md` | Original assets, source attribution, version pins |
| Cloud and evaluation | `infra`, `docs/evaluation.md` | Equivalent behavior, measured claims, cost evidence |

Agree task ownership before overlapping edits. Work in separate worktrees from
the latest `origin/main`. Keep changes focused and run the relevant reference path
when behavior changes. See [implementation plan](implementation-plan.md).

## Remaining work

AWS identity, DynamoDB, deployment packaging, IaC, and streaming need a cloud
spike. Local SQLite and account selection are development adapters. No deployment
or hosted load claim follows from these checks.

LLM orchestration, Learn, Code Review, published real-incident scenarios, scoring
weights, and learner evaluation remain planned. The synthetic draft is not a
named-company reconstruction. Team review must precede publication.

Before a hosted pilot, implement production identity, origin and rate controls,
backup/restore, retention, monitoring, and provider limits. Use the
[architecture checklist](architecture.md) and evaluation plan. Keep the current
deterministic core and direct controls usable throughout these additions.
