# Optional LLM integration

Status: proposed implementation. The model/provider remains open.

## Responsibilities

The model interprets a request, selects an available investigation tool, explains
its deterministic result, and proposes mitigation for confirmation. It can explain
concepts using visible evidence and released hints. It does not own state, choose
scores, invent telemetry, read private definitions, or grade arbitrary reasoning.

The reference scenario has no prepared hints. Its first conversational integration
uses visible evidence only. Before adding hints, I06 must define their authored
release conditions, public shape, and assistance event in the shared contracts.
The model must not invent or independently release a hint.

## Context on every turn

Build context from application state, not from provider memory:

1. Role and evidence rules.
2. Current public session projection and its version.
3. Relevant revealed evidence and its observation tick.
4. Recent committed direct and conversational actions.
5. Allowed tool schemas and scenario-visible target values.
6. Relevant conversation and the current request.

Do not send resolution predicates, hidden evidence, private variable names, answer
keys, future event templates, or unreleased debrief text. Treat user input and
scenario artefact text as data, never as authority to change these boundaries.
Prompt rules supplement server enforcement. They are not the security boundary.

## Bounded turn

Persist a unique turn and input version. Call the provider with function schemas.
Validate a tool call before any effect. Execute allowed investigations through
the coordinator, save results, then call the model to explain them. Preserve the
full conversational loop before optimizing latency.

Proposed starting limits are three executed investigation calls per turn, one
active turn per session, a 45-second provider deadline, and a configured token
budget. These are cost controls to validate, not published responsiveness promises.
Loop limits produce a clear partial result and allow the learner to continue.

Direct controls remain available during a turn. If a direct action changes state,
the next LLM action fails its version check. Do not retry it silently. An explanation
of already committed evidence remains labelled with the version/tick it describes.
The next conversational turn uses fresh application context.

Mitigation selection produces a stored proposal with command, version, expiry,
and owner. Display its target and time cost without revealing hidden consequences.
The learner confirms it through the normal action route. The LLM cannot set the
confirmation flag. After confirmation, explanation can use the saved action result.

## Failure handling

- Invalid tool or target: return a typed validation result without state change.
- Provider failure before action: mark the turn failed, keep direct controls active.
- Provider failure after action: retain the committed result and show it directly.
- Browser disconnect: the application may complete the bounded turn. A retry reads
  the saved turn instead of starting another model call.
- Expired worker lease: mark an interrupted turn for recovery. Never execute a new
  action until receipt lookup establishes whether the previous one committed.

When session answers are released, record that fact. Any later replay is informed
practice. Hints, provider usage, and assisted/unassisted status appear in evaluation
metadata. They do not let the model alter the deterministic score.

## Provider boundary

Use one small adapter for messages, tool schemas, streaming deltas, tool calls,
usage, and errors. Do not build a general agent framework. Keep provider credentials
server-side. Log timings and token counts, not full prompts or hidden content.

Benchmark selection and parameters using the same registry as the direct UI.
Include ambiguous requests, unavailable services, attempts to obtain answers,
manual-action context changes, and provider failures. The model must ask for
clarification when a safe typed operation cannot be selected.
