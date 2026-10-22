# Deploy the learner browser

The browser uses `OpsReplayBrowserHosting`. The runtime retains its separate terminal
CloudFront route. Both origins use default AWS hostnames. No custom domain is required.
A disposable deployment exercised the real browser flow on 17 October 2026.
See the [checkpoint report](checkpoints/2026-10-17-browser.md) for the tested
revision, findings and limits. No runtime remains deployed.

## Order

1. Deploy the static browser stack with empty connection-origin parameters. It creates
   a private asset bucket and returns the browser origin, callback and logout URLs.
   Do not publish configuration yet. The application fails closed without it.
2. Use those exact URLs for the runtime's API CORS origin, terminal allowed origins and
   Cognito callback/logout settings. Use the existing managed/external identity contract.
   Do not create a second user pool. Verify runtime and identity before opening starts.
3. Set the browser stack's `ApiOrigin`, `CognitoAuthorityOrigin`, `CognitoLoginOrigin`
   `TerminalOrigin`, and `RecordingOrigin` to the exact origins from that runtime. The API parameter is
   its HTTPS host, without the stage path. The terminal parameter is the WSS host,
   without `/v1/terminal`. The recording origin is the exact S3 host used by signed links. These values bound the browser CSP.
4. Create an ignored public config file from `apps/web/public/config.example.json`.
   Use the real API base including its stage, Cognito authority including pool ID,
   client ID, login URL, and exact callback/logout URLs. These are public identifiers.
   Validate it with `node --import tsx scripts/prepare-browser-config.ts input.json
https://<browser-host> .local/config.json`. The output must not already exist.
5. Run `npm ci`, `npm run quality`, `npm run check`, `npm run web:test` and
   `npm run web:build`. Publish only hashed files under `dist/web/assets/`, then
   all Free lesson bodies and their index, `index.html`, then the validated `config.json`.
   Use `node scripts/browser-upload-plan.mjs dist/web` to validate and list the exact
   ordered files before uploading. It rejects missing/mismatched Free lessons and
   excludes prepared Pro bodies and example configuration. Keep old hashed files for active tabs.
   Use immutable caching for assets and `Cache-Control: no-store` for HTML/config.
6. Verify login/callback, start/resume, terminal reconnect, hints, end, debrief and
   playback with the deployed browser. Check the browser console and failed requests.
   Local fixtures do not prove Cognito, CORS, CloudFront or AWS behavior.

`npm run web:test` also uses Docker for the browser-to-handler DynamoDB Local
recovery tests. Those tests use dummy credentials and simulated external adapters;
they make no AWS calls. The reviewed live follow-up uses the
[browser verification checklist](runbooks/browser-checkpoint-verification.md).

The asset bucket is private. CloudFront has signed reads limited to `index.html`,
`config.json` and `assets/*`, bound to that distribution ARN. An operator needs only
upload permissions for those paths. The stack creates no publisher Lambda.

## Recording CORS

Playback object URLs remain signed, short-lived, and owner-authorized by the API.
The browser reads them directly from the retained recording bucket. Set `BrowserAllowedOrigin` on `OpsReplayDurableResources` to the exact browser
CloudFront origin. The owner enables GET CORS only; an empty value omits CORS. S3 CORS grants no object
permission. Keep public access blocked and the existing retention rules.

## Routes and caching

The home entry is `/`; the Challenge catalogue is `/challenges`. Publish the updated
CloudFront route function before the new browser assets so direct navigation and
sign-in returns can reach the catalogue. Existing session routes keep their meaning.

Only `/`, `/challenges`, `/auth/callback`, and valid `/sessions/<uuid>` paths with optional `/debrief`
map to `index.html`. Unknown paths, missing assets and backend paths keep their error
status. There is no global 403/404-to-HTML fallback. The browser supports strict CSP
without script evaluation. xterm requires inline styles. Connection origins are exact;
S3 GET links are bounded to AWS S3 hosts in both CSP and the asset reader.

## Rollback

Disable starts before a deployed runtime rollback. Restore a previous verified HTML
and config pair while retaining its hashed assets. Revert static hosting independently
of runtime and learner data. The bucket and its policy are retained on stack removal.
Do not delete durable recordings or user identity during browser rollback.
