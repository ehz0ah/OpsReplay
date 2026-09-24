# API application boundary

Status: not implemented. Follow [architecture](../../docs/architecture.md),
[API](../../docs/api.md), [data model](../../docs/data-model.md),
[Challenge environments](../../docs/challenges.md), and
[LLM integration](../../docs/llm.md).

Own the Lambda handlers: identity, plans, catalogue, Learn, session start and end,
terminal tickets, hints, timeline, debrief, playback, Code Review matching, and
assistant turns. Also own the lifecycle handlers for readiness, time limits, the
heartbeat sweep, reconciliation, and the finaliser. Keep the LLM handler separately
deployed while sharing modules.

First task: implement the session lifecycle against an in-memory repository and a local
Docker launcher. Prove duplicate-safe start and end, the first-outcome-wins rule, and
that every ended session stops its environment. Production configuration must reject
development identity.
