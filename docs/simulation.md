# Simulation contract

Status: v0.1 domain contract implemented by the local engine. Numerical values in
the reference scenario are synthetic examples,
not production measurements or final scoring weights.

## Engine interface

```text
start(definition, engineVersion) -> state, initialEvidence, logicalEvents
step(definition, state, validatedCommand) -> nextState, output, logicalEvents
project(definition, state, revealedEvidence) -> publicView
debrief(definition, terminalState, eventHistory) -> debrief
```

The application supplies IDs, wall-clock timestamps, identity, and request version.
The engine never reads the system clock, network, environment, or random generator.
Content and engine versions are pinned for the entire session and each replay.

## State and time

State includes scenario variables, simulated tick, revealed evidence, cumulative
costs, event trigger flags, and terminal status. A tick is one authored simulated
minute in the reference scenario. Future content may define another fixed duration.
All time costs are integer ticks. The web UI converts ticks to an incident clock.

`GET` endpoints and rereading stored evidence cost no simulated time. A fresh
investigation operation has its authored cost, even if the learner repeats it
with a new request ID. An identical network retry has no additional effect.
Auto-refresh may read the current projection but must not issue paid investigation
operations. Explicit `advance_time` accepts a bounded tick count.

An action's authored duration is the period after its immediate effect until the
next observation. This MVP does not model independently running action jobs.
Delayed consequences are represented by state and tick rules.

## Action processing order

1. Validate ownership and access at the API boundary. Resolve duplicate receipts.
2. Validate expected session version, status, tool schema, target values, and
   scenario prerequisites. Invalid requests change no state, time, or costs.
3. Capture an eligible pre-action checkpoint before the first mitigation.
4. Apply immediate effects in authored order, using the previous assignment's
   result for later assignments. Record the action at the current tick.
5. For each action-cost tick, increment the clock, run tick assignments in order,
   derive metrics, accumulate impact, and evaluate event rules.
6. Evaluate terminal conditions after each tick. Failure has priority if both
   conditions are true. Stop at the first terminal tick, including during wait.
7. Reveal the requested evidence at the resulting tick and construct the output.
   A valid investigation that ends in failure still returns its requested evidence.
8. Append a result event and return the candidate state for one atomic commit.

Action selectors match fixed argument values after registry validation. Exactly
one scenario action must match. Other fields, such as log filters and time windows,
constrain observations. They do not select a new transition. Reject overlapping
selectors for one tool during definition validation.

Every accepted command increments the persistent session version once, regardless
of tick count. Logical events use deterministic sequence numbers, not timestamps.
The application adds wall-clock audit metadata separately. Rejected requests
belong in application telemetry, not the scored logical path.

## Declarative rules

The [scenario schema](../packages/contracts/schemas/scenario.schema.json) uses
literal expressions, state references, command arguments, and a small operator
set. Assignments target declared state variables. Operators are `add`, `sub`,
`mul`, `min`, `max`, `eq`, `gte`, `gt`, `lt`, `and`, `or`, `not`, and `if`.
There is no code evaluation, I/O, random value, or loop expression. The engine
checks operand types, arity, variable bounds, and finite safe integers.
Expressions have maximum depth 20 and 200 nodes. Both arms of an `if` must be valid.
Use strict types without coercing strings to numbers or booleans.
Before schema validation, reject definitions beyond 50 structural levels or
100,000 nodes. This prevents recursive input from exhausting the validator stack.
Per-tick impact is bounded at 200,000 units so 5,000 ticks fit the public cost limit.

Time is available as `tick`. Command arguments are available only in action
effects or prerequisites, not tick, event, metric, or terminal rules. Predicates
must return booleans. State assignments must preserve the declared type/range.
Definitions with a possible out-of-range result require a clamp or a rejecting
validation error. Do not silently clip values unless the rule explicitly does so.

Event predicates are evaluated against the resulting tick state. An event is
emitted on a false-to-true transition, using saved trigger flags. Stable true
conditions do not flood the timeline. Checkpoints include these flags.

The first engine must validate definitions before accepting sessions. Structural
validation alone cannot prove reachability for arbitrary rules. Publish only
after authored success, failure, and alternative traces pass the real engine.
The fixture validator in this baseline checks the reference example, not all
possible scenarios.

## Evidence and visibility

Private definitions hold authored metrics, logs, diffs, runbooks, source notes,
resolution rules, and answers. The browser gets a public catalogue entry, a
session projection, and only evidence already revealed through valid operations.

Discovered evidence is stored with its tick and version. Old evidence remains an
observation at that time. Opening it again must not replace historical values with
new values. A fresh investigation requests a new observation. Current status
indicators expose only metrics declared visible by the scenario.
Observation IDs combine session ID, commit version, and evidence ID.

Metric windows cover the requested number of intervals through the observation
tick, inclusive of both endpoints and clipped to available samples. The initial
sample is at tick zero. Log windows use the same clock and include authored log
templates whose event occurred in the window. Severity and text filters apply to
those entries. Deployment windows use the observation tick and can include authored
negative ticks before incident start. Diffs require prior deployment discovery.
Only the selected evidence is exposed, never unused templates or future samples.

Graphs use the same deterministic state-derived time series as tool results.
Chart markers identify the action tick. A displayed historical line cannot
contradict the event record for that tick. No fabricated LLM measurements.

## Reference connection-leak scenario

The [synthetic definition](../content/challenges/checkout-connection-leak/scenario.json)
demonstrates the minimum semantics. It has checkout, payment, and a shared database.
At tick zero there are three application instances, 50 leaked connections, no
queued work, and the faulty version is active.

```text
base connections = 40 + (instances - 3) * 10
each faulty tick adds instances * 4 leaked connections, capped at 200
total connections = base connections + leaked connections
if total >= 100: queued work grows by 20, capped at 200
otherwise: queued work drains by 10, floored at 0
```

Checkout error percent is 50 under connection overload, 15 with remaining queued
work, 27 at 80–99 connections without queued work, and 0 otherwise. Payment error
percent is 20 under overload, 5 with queued work, and 0 otherwise. These are a
deliberately simple teaching model, not a general queueing model.

Rollback closes leaked connections and removes the faulty version. It leaves
queued work and instance count unchanged. Restart closes leaked connections but
keeps the faulty version. Scaling to six instances adds connection demand.

Recovery requires the faulty version to be removed, no queued work, and fewer
than 80 connections. Failure occurs at 120 queued items or tick 20.

| Path from initial state | Terminal/result tick | Impact units | Result |
| --- | --- | --- | --- |
| Rollback | 1 | 0 | Resolved |
| Scale to 6, rollback, advance 3 | 6 | 200 | Resolved after backlog drains |
| Restart, advance 4 | 5 | 97 | Active again with overload |
| Advance 10 | 6 | 420 | Failed at queue limit before the requested wait ends |

Impact units are the sum of checkout and payment error percentages after each
tick. This is a raw reference cost, not a final score. Investigation time, total
elapsed time, and impact are separate components. Temporary relief has value
through reduced cumulative impact, even if it does not satisfy recovery.

## Replay

The initial checkpoint and one pre-first-mitigation checkpoint are the proposed
reference checkpoints. Content may declare fewer. The API exposes replay only
after the original attempt is resolved, failed, or ended by the learner.

A replay is a new owned session pointing to the immutable parent/checkpoint. Copy
all engine state, evidence, costs, metric samples, and event flags at the checkpoint.
New event numbering starts in the child, with the parent prefix referenced rather
than modified. The child version starts at zero. It inherits whether hints or
answers have already been seen. It is always labelled informed practice.
Parent observation IDs stay stable through the copied prefix. Child observations
use the child session ID and commit version to avoid collisions.

Compare both paths from the same checkpoint. Report elapsed ticks and impact
deltas since that point, not the child's totals against the parent's full attempt.
If one path does not recover, show status and observed duration, not a fictitious
recovery time. Disable replay-of-replay initially to keep ancestry and comparisons
bounded. Original scores and history never change.
