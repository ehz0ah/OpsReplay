# Content authoring

Status: manual authoring workflow. There is no content-generation or authoring UI.

## Source and ownership

Use official engineering incident reports for inspiration. Write original service
names, logs, code examples, metric values, and explanations. Link to the original
source and record which failure mechanism was adapted. Public availability does
not imply permission to copy text, figures, or code. Keep third-party notices when
licensed material is deliberately reused after review.

The current connection-leak definition is synthetic and draft. It has no claimed
company incident source and cannot be published as historically sourced content.
Its purpose is to prove the contract and trace calculations.

## Challenge structure

A definition contains immutable identity/version, publication status, learning
objectives, services, declared variables, initial state, fixed tick duration,
initial evidence, typed actions, tick rules, metric projections, event triggers,
terminal rules, checkpoint policy, impact expressions, provenance, and debrief.

Use the [schema](../packages/contracts/schemas/scenario.schema.json) and
[reference scenario](../content/challenges/checkout-connection-leak/scenario.json).
Every evidence ID and action must exist. Tool arguments must match the registry.
Every action must define a visible target and cost without naming hidden truth.

Evidence data has a schema for each kind. Diff lines include their file, stable
line ID, line number, change kind, and text. Architecture dependencies use explicit
`from` and `to` service names. The engine must not invent filenames or line numbers.
Metric and status templates select one declared metric. Log templates reference
declared event IDs and are rendered at the time that each event occurred.

## Evidence quality

Evidence should support diagnosis without stating the answer. Include realistic
noise only when it teaches prioritisation. Avoid arbitrary irrelevant branches.
Use units and consistent simulated timestamps. Logs, deployment history, code
diffs, and metric rules must describe the same failure mechanism.

The numerical model should be explainable. Do not claim it reproduces a real
database or scheduler. Document simplifications and show how action order changes
future state. A temporary mitigation can reduce impact even if recovery is incomplete.

## Publication checks

1. Validate schema, IDs, references, tool parameters, bounds, and source metadata.
2. Run a successful path, a failed path, a harmful path, and temporary mitigation.
3. Verify the same commands produce identical engine results.
4. Restore each checkpoint and compare the repeated suffix with the original.
5. Check that alternative paths retain earlier consequences and do not overwrite
   the first attempt.
6. Inspect browser-visible output and LLM context for accidental answer leakage.
7. Have another team member review causal realism, evidence, difficulty, and debrief.
8. Publish a new immutable version and pin existing sessions to their old version.

Structural validators cannot prove arbitrary graph reachability. Required recovery
and failure states need actual engine trace evidence before publication.

## Learn and Code Review

Learn entries include title, domain, summary, lessons, and official source links.
Keep them free. Code Review includes difficulty, an available language, context,
diff, allowed line anchors, and private authored findings. Validate that each
finding points to a real diff line. Do not add a language option without content.

Investigation actions must bind target names in their selectors. Their revealed
evidence must match the tool kind, service, metric, and deployment where applicable.
Query windows, log filters, and bounded counts can remain parameters. State
prerequisites that depend on arguments are checked when the command is submitted.
