# API application boundary

Status: not implemented. Follow [architecture](../../docs/architecture.md),
[API](../../docs/api.md), [data model](../../docs/data-model.md), and
[LLM integration](../../docs/llm.md).

Own authentication, access grants, request validation, session coordination,
repositories, provider orchestration, public projections, and telemetry. Keep
gameplay and LLM handlers separate at deployment while sharing domain modules.

First task: create the local coordinator and session/action routes using an
in-memory repository. Prove ownership, retries, stale requests, and saved results
before wiring a provider. Add persistent local storage before claiming restart
recovery. Production configuration must reject development identity.
