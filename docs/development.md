# Local development

Use Node 22 and npm 10+. The exact development version is in [.nvmrc](../.nvmrc).
With nvm, run `nvm install` and `nvm use`. Unsupported Node versions are rejected.

## Start

```sh
npm ci
npm run check
npm run dev
```

Open <http://127.0.0.1:5173>. Select Local learner or Local teammate. Each has
separate attempts. No AWS account, Docker, password, or LLM key is needed.

Fastify runs at port 3001 and Vite at 5173. Vite proxies API requests through the
same origin. Keep the same hostname. Switching between `localhost` and
`127.0.0.1` changes browser storage and cookies. Ctrl+C stops both processes.
If either exits, the other is stopped too.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | API watch and frontend hot reload |
| `npm run dev:api` / `npm run dev:web` | Start development processes separately |
| `npm run build` | Build static frontend into `apps/web/dist` |
| `npm start` | API and built frontend at port 4173 |
| `npm run check` | Contracts, links, types, lint, formatting, tests, build |
| `npm run contracts:sync` | Regenerate OpenAPI components and TypeScript types |
| `npm run contracts:generate` | Regenerate TypeScript types from schemas |
| `npm run typecheck` | Check root and workspace types |
| `npm run lint` | Check TypeScript rules and browser import boundaries |
| `npm run format` | Format application source and configuration |
| `npm test -- <test-file>` | Run a focused Vitest test file |
| `npm run test:coverage` | Report coverage for configured tests |

Build before `npm start` and stop `npm run dev` first. Vite preview checks built
assets. It is not a hosted production server. The local API refuses
`NODE_ENV=production` because the account picker is not production identity.

## Configuration and storage

Defaults work without an environment file. The API reads shell environment
variables only. No provider key is read in this slice.

| Variable | Default | Use |
| --- | --- | --- |
| `OPSREPLAY_API_PORT` | `3001` | Change API port and frontend proxy together |
| `OPSREPLAY_DB_PATH` | `.local/runtime/opsreplay.sqlite` | Select a SQLite file |

Use an absolute database path. Example: `OPSREPLAY_API_PORT=3002 npm run dev`.
If starting processes separately, set the same API port for both. Frontend ports
stay 5173 for development and 4173 for preview. Occupied ports cause startup failure.

`.local/runtime` contains SQLite, its WAL files, and generated `session.key`.
These files are ignored by Git. The key preserves signed cookies and pagination
cursors across restarts. Do not print, commit, or share it. Keep the database on
a local filesystem. Do not sync it while the server runs.

For a backup, stop the API and copy the entire runtime directory to private local
storage. Restore only while the API is stopped. Keep the database and key together.
For a separate experiment, set a new database path. Tests create and remove only
their own temporary databases.

Content is pinned by ID, version, and hash. Editing a definition already used by
the database makes startup fail. Preserve old versions for old sessions. Use a
separate database for draft experiments. Do not remove content pins to change an
existing attempt's scenario.

## Request recovery

The browser stores each pending operation in `sessionStorage` before sending it.
If the response is lost, use **Retry saved request**. It reuses the request ID and
returns its receipt without applying or scoring the action again.

Keep the tab and its storage until recovery finishes. Refresh preserves the
pending request. Closing the tab or clearing site data can remove its recovery
record. Server progress remains in Your attempts. If storage is disabled or
invalid, the interface stops writes. Enable storage and reload. Do not clear an
uncertain mitigation and resend it under a new ID.

A version conflict means another request changed the attempt. Review the refreshed
state before choosing another action. A learner change in another tab cannot
apply an old request under the new identity.

## Workspace boundaries

`apps/web` owns rendering, the pending request journal, and server-data caching.
It imports public contracts only. It cannot import private content, the engine,
or API internals. `apps/api` owns identity, validation, and transactions.

`packages/engine` owns deterministic behavior. Transitions do not read clocks,
environment variables, files, or network services. `packages/contracts` owns
schemas and generated types, with separate public and private exports.

`content` stays on the server. `infra` will hold deployment code when AWS work
starts. See [architecture](architecture.md) and [local handoff](local-handoff.md).

## Troubleshooting

- Node install error: run `nvm use` and check `node --version` before `npm ci`.
- SQLite native module error: reinstall with Node 22. Platforms without a prebuilt
  package need their normal C++ build tools.
- Port occupied: stop the earlier process. Do not run dev and preview with the
  same API port. Use the override for an independent instance.
- API unavailable: check terminal output and <http://127.0.0.1:3001/health>.
  A changed port must match the frontend proxy.
- Preview missing: run `npm run build` before `npm start`.
- Content hash mismatch: restore the definition used by saved sessions or select
  a separate database for the edited draft.
- Workspace cannot open: check browser storage and the local server. SQLite
  contains saved progress. The browser does not own authoritative state.

## Git workflow

Keep the main checkout on `main`. Fetch `origin` and create implementation
worktrees from `origin/main`. Use focused commits with a personal Git identity.
Run checks and inspect the staged diff before committing.

Commit the lockfile and generated contracts with their inputs. Runtime files,
credentials, coverage, LoopX state, dependencies, and build output stay ignored.
