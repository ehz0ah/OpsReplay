# API application boundary

Status: local Challenge API implemented. Follow [architecture](../../docs/architecture.md),
[API](../../docs/api.md), [data model](../../docs/data-model.md), and
[LLM integration](../../docs/llm.md).

Own authentication, access grants, request validation, session coordination,
repositories, provider orchestration, public projections, and telemetry. Keep
gameplay and LLM handlers separate at deployment while sharing domain modules.

Run `npm run start --workspace @opsreplay/api` from the repository root. The server
listens at `http://127.0.0.1:3001`. `GET /health` checks that it is serving requests.
Data and a generated cookie key live under `.local/runtime`, outside Git.
`OPSREPLAY_DB_PATH` and `OPSREPLAY_API_PORT` override the database path and port.

Modules: `app` owns HTTP and local identity, `sessions` coordinates operations,
`content` loads compiled definitions, and `sqlite` implements atomic persistence.
`repository` is the storage port. The engine has no dependency on these modules.

The development-only `/dev/accounts`, `/dev/login`, `/dev/logout`, and `/dev/me`
routes use two explicit local learners. Login accepts `{"accountId":"local-learner"}`.
All mutations require `X-OpsReplay-Client: web`. Browsers must use an allowed local
origin. The browser also sends `X-OpsReplay-Owner` with its expected learner ID.
This header must match the verified cookie and grants no authority. It prevents
stale tabs from writing for a different learner. HTTP-only signed cookies persist
login across restarts. There is no public
signup or identity provider in this slice. `NODE_ENV=production` is rejected.

The synthetic draft appears in the local catalogue. Published-only selection is
supported by the content repository, but the local entry point explicitly enables
drafts. No LLM calls or AWS services are used.

Integration tests exercise real temporary SQLite files, duplicate requests, two
database connections, injected transaction failure, restart recovery, access,
pagination, debrief and replay comparison.

Use `npm run dev` at the root to start both API and browser. For storage, port
overrides, and recovery, read [local development](../../docs/development.md).
