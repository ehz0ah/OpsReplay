# Interface design contract

Status: functional design. The first Challenge uses React/Vite, Mantine controls,
Recharts, and locally bundled IBM Plex fonts. Frontend contributors can refine
the layout while preserving this behaviour. Learn and Code Review remain planned.

## Navigation

The primary navigation has Learn, Challenges, and Code Review. Practice catalogue
entries show title, difficulty, domain, and access. Code Review also shows language.
Only filters represented by published content appear. Free Learn remains usable
without purchasing or starting an incident.

## Challenge workspace

The workspace presents incident identity, current simulated time, visible service
status, monitoring, resource exploration, an event timeline, and action controls.
An optional assistant panel shares the same workspace. A learner must be able to
complete the Challenge with that panel closed.

Use one clock and one session version. Place action markers on metric charts.
Evidence panels show when the observation was made. Keep older observations
available for comparison and clearly distinguish them from current status.
Refreshing the page restores the session without advancing incident time.

Separate investigation controls from mitigation. Show the target, requested
parameters, and simulated time cost before a mitigation is confirmed. Do not show
its hidden result as a tooltip. No repeated notification overlays that interrupt
investigation. New events appear in the timeline with a restrained indicator.

## Interaction states

| State | Behaviour |
| --- | --- |
| Loading | Preserve layout, show progress, disable only the pending operation |
| Action pending | Retain request ID, prevent duplicate clicks, show pending state |
| Network outcome unknown | Retry the same request or read its saved result, never issue a new mitigation automatically |
| Version conflict | Refresh current state and ask the learner to reconsider the stale action |
| Provider failure | Show saved deterministic output and keep direct controls available |
| Terminal session | Freeze actions, open debrief, make eligible replay choices available |
| Replay | Show the parent checkpoint and an informed-practice label |
| Comparison | Align chart time and cost deltas to the shared checkpoint |

## Debrief and comparison

The debrief follows the learner's path, connects evidence to the causal chain, and
explains temporary, harmful, and effective mitigations. Include important missed
evidence and official incident inspiration. Keep authored explanations available
without an LLM.

Replay starts from an eligible saved decision point. It does not overwrite the
first attempt or present a better informed score as a first-attempt improvement.
Comparison shows status, recovery duration when achieved, cumulative impact, and
the actions that caused divergence. Failed paths remain visible as failed paths.

## Code Review

Show context and a readable diff with stable line anchors. Learners mark suspicious
lines and explain concerns. After submission, show authored findings and compare
locations and explanations. Do not display a false objective grade for free text.

## Accessibility and responsive behaviour

All actions work with a keyboard and have visible focus. Labels and status text
must not depend on colour alone. Charts provide units, legends, and a text/table
alternative. Diffs and logs support horizontal scrolling without shrinking text
to fit. On narrow screens, switch panels through labelled tabs and preserve context.
Avoid interface motion that interferes with reading or changes logical time.

## Frontend data boundary

Consume the public contract only. Do not import `content/challenges` or private
answer assets. Do not calculate authoritative impact, success, or state transitions
in browser code. A local visual estimate must never replace server results.
