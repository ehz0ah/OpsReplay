# Browser application

Static React application built by Vite with Mantine controls. Client libraries are build dependencies, so
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

Follow [design](../../docs/design.md) and [API](../../docs/api.md) for Cognito sign-in,
entry, live workspace and results. Runtime state, recovery and scores
remain backend-owned.

`npm run typecheck` checks the server, browser and browser test/tooling projects
separately. Server checks use Node types without DOM or JSX. Browser source checks
use DOM types without Node globals. Browser tests and Vite config also have Node types.
All projects share the same strict compiler options in `tsconfig.base.json`.

Sign-in uses the hosted Cognito code flow with PKCE, state and nonce validation.
Authorization state and tokens are tab-scoped. Expired ID tokens use one shared refresh
request when a refresh token exists; otherwise sign in again. Logout clears local
identity even if revocation is unavailable, then opens Cognito logout using public
identifiers only. Live Cognito behaviour still requires the browser AWS checkpoint.

The catalogue is public. Account bootstrap controls plan display and offers the owned
active attempt for resume. New starts use the exact published version. Pending start
requests keep their ID across reloads and errors. Recover the saved request before
starting another. HTTP and storage errors never cause an automatic new mutation.
Response validators load by entry, session or results group, keeping results code out
of the initial catalogue bundle.

The workspace polls saved session state serially, cancels requests when leaving, and
backs off after throttling. Its real-time countdown displays the saved deadline without
deciding the outcome. Ending requires confirmation and preserves the same request ID
until the server confirms its result. Terminal outcomes stop interaction and lead to
the debrief when the backend marks it available.

The workspace shows the terminal beside an evidence panel on desktop. Narrow screens
use labelled tabs. Tabs use display-only hiding to keep the shell connection and typed
input alive. Do not use React Activity hiding for the terminal. Size changes use one
animation-frame resize and never open a new shell. Ctrl+Shift+F6 moves focus from the
terminal to its screen-reader control without sending the shortcut to Bash.

Mantine styles are imported only for used components. Theme values live in `src/theme.ts`;
workspace layout lives in `src/styles.css`. Keep labels, focus, stale-data messages,
hint confirmation, and end confirmation when changing the presentation. Charts retain
missing-data gaps and provide the latest 60 samples in a table.

Recorded terminal playback supports pause/resume, reset, seek and 0.5× to 4× speed.
Seeking backward reconstructs saved output and dimensions. The range covers loaded terminal and metric tracks and capture completion times; load continuation pages to extend it. Refreshing links resets the
loaded recording. Playback never sends recorded input to a running environment.

Saved telemetry follows the same playback position and shows its latest sample time.
Only the latest completed capture is loaded. Its baseline and read interval remain
visible; an in-progress capture does not reveal its after-state. Metric reads enforce
recording totals, and the capture cache holds at most eight objects.

Load the saved timeline to add command markers. Chart or timeline selection seeks
playback and shows the saved command result with its completion time. Chart markers
support Enter and Space and show at most 120 loaded commands; the timeline includes
all loaded commands. Selection never runs a command. Output excerpts cover the saved
command and do not represent an exact snapshot at the playback position.
