# Web application

The first Challenge interface uses React, Vite, Mantine, React Query, React Router,
and Recharts. IBM Plex fonts are bundled locally. Read [design](../../docs/design.md)
and [API](../../docs/api.md) before changing behavior.

Run `npm run dev` at the repository root. It starts both API and web. For the
built frontend, run `npm run build` then `npm start`. See
[local development](../../docs/development.md) for ports and storage.

## Structure

- `pages` owns catalogue, investigation, debrief, and replay comparison.
- `components` owns evidence rendering, charts, timeline, and typed action forms.
- `api/client` validates public responses and binds requests to the signed learner.
- `api/journal` preserves pending request IDs across reloads and network failure.
- `api/mutations` executes writes and coordinates recovery.
- `api/cache` prevents older session projections from replacing newer ones.
- `api/observations` merges immutable observations from paginated event history.
- `styles.css` owns layout and theme. Mantine owns basic controls.

Keep each control under one library. Add shadcn/ui only for a concrete need.
Pages and charts load separately. Chart tables provide a readable alternative.

Import public contracts only. Never import private content, engine state, or API
internals. Reading, rendering, and waiting never advance simulated time. Every
write uses the shared journal and server validation.

Transport integration tests run against Fastify and SQLite. Browser flow and
accessibility evidence is recorded in [local handoff](../../docs/local-handoff.md).
There is no unattended browser regression suite yet.
