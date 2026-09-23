# Local development

Use the Node version in [.nvmrc](../.nvmrc) and npm 10 or later. If using nvm,
run `nvm install` and `nvm use`. The repository rejects unsupported Node versions.

```sh
npm ci
npm run check
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run check` | Contracts, types, lint, formatting, and unit tests |
| `npm run contracts:sync` | Regenerate OpenAPI components and TypeScript types |
| `npm run contracts:generate` | Regenerate TypeScript types from schemas |
| `npm run typecheck` | Check root configuration and all workspace types |
| `npm run lint` | Check TypeScript rules and browser import boundaries |
| `npm run format` | Format application source and root TypeScript configuration |
| `npm test -- <test-file>` | Run a focused Vitest test file |
| `npm run test:coverage` | Report application unit-test coverage |

## Workspace boundaries

`apps/web` owns browser rendering and interactions. It imports public contracts.
It cannot import scenario data, the engine, or API internals.

`apps/api` owns HTTP handling, identity, storage transactions, and optional LLM
orchestration. It calls the engine through typed commands.

`packages/engine` owns deterministic scenario behaviour. It must not read clocks,
environment variables, files, or network services during a state transition.

`packages/contracts` owns the schemas and generated types. Its default export is
type-only. Private types and runtime helpers have separate package entry points.

`content` stays on the server. `infra` will contain deployment code in the same
repository when AWS work begins. See the [repository map](../README.md) and
[architecture](architecture.md) for the full structure.

## Git workflow

Keep the main checkout on `main`. Start implementation in a worktree from the
latest `origin/main`. Use focused commits with a personal Git identity. Run
checks before committing. Review the staged diff for unrelated files or secrets.

Runtime files, credentials, test coverage, and LoopX state are ignored. Commit
the lockfile, schemas, and generated types together when their inputs change.
