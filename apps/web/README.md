# Browser application

Static React application built by Vite. Client libraries are build dependencies, so
production-only backend installs do not include them. Public DTOs come from `public.schema.json`;
`contracts:check` rejects stale checked-in types and compiles browser validators without
runtime `eval`. Private contracts and Challenge files are never imported by this app.

```sh
npm ci
npm run web:test
npm run web:build
```

For development, copy `public/config.example.json` to `public/config.json` and replace
its placeholders with the verified API and Cognito configuration. Redirects must match
`http://localhost:3000/auth/callback` and `http://localhost:3000/` in the public client.
Run `npm run web:dev`. The file is ignored. It contains public identifiers only.
No local authentication server or fake game runtime is provided.

Build output is `dist/web`. Configuration is loaded from `/config.json` without caching.
An absent or invalid configuration shows a recoverable error. Production redirects must
use the exact HTTPS browser origin. Hosting remains separate from this boundary.

Follow [design](../../docs/design.md) and [API](../../docs/api.md). The following PRs add
Cognito sign-in, entry, live workspace and results. Runtime state, recovery and scores
remain backend-owned.

`npm run typecheck` checks the server, browser and browser test/tooling projects
separately. Server checks use Node types without DOM or JSX. Browser source checks
use DOM types without Node globals. Browser tests and Vite config also have Node types.
All projects share the same strict compiler options in `tsconfig.base.json`.
