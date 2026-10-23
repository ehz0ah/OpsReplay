# Learner experience checkpoint, 23 October 2026

The deployed baseline was `ac2781f`. The user completed a personal trial and
authorized developer testing within the existing temporary AWS window. The
updated frontend was then tested against the same managed API and retained data.
One user supplied the sign-up email confirmation code. This was functional
testing, not a classroom pilot or a learning-effectiveness study.

## Confirmed defects and changes

- Sign-up was absent because the pool accepted only admin-created users. Create
  account now uses hosted Cognito registration with email verification and PKCE.
- The live review lost a saved draft comment after refresh. Drafts now restore
  saved comments and the unfinished editor, isolated by learner and version.
- The comment editor appeared below the whole diff. It now opens at the selected
  line, with edit/delete controls, before/after gutters and a file navigator.
- A successful submission stayed on a transient exercise page. It now opens the
  saved result URL; matching-version diff context is optional when reopening it.
- Recovery time moved in five-second steps. The display now animates already
  confirmed time and resets on a failed check. It does not predict success.
- The account controls can wrap on small screens. The header now grows to fit
  them rather than fixing its height at 60 pixels.

## Observed AWS browser checks

- A Free test account signed in through Cognito and submitted a review. Its saved
  result reopened from history and survived refresh.
- The updated review restored a draft after refresh, saved an edited comment,
  required submission confirmation and opened a stable saved result. The result
  showed the same inline comment after reopening.
- A weak password disabled registration. A valid password reached email
  confirmation. An incorrect code was rejected; the supplied code completed
  confirmation and the normal PKCE callback. The new account had Free access.
- That new account could not read another learner's saved review. The page
  returned no result or reference findings.
- The existing Wrong upstream port attempt resumed, accepted an evidence-based
  assistant command only after confirmation, recovered through nginx validation
  and reload, and produced a finalized debrief. The developer's assistant request
  returned a relevant read-only port check in about 5.9 seconds. One request does
  not establish a latency distribution or accuracy rate.
- A separate Stale DNS attempt reached readiness, exposed the real stale answer
  and listener mismatch, and kept checkout failing after DNS-only repair. A
  validated nginx reload restored checkout; sustained checks resolved it. The
  recorded timeline and terminal playback controls worked.
- At a 390-pixel viewport, the updated app header fit without page overflow.

## Local checks and limits

Contracts, lint, TypeScript, frontend build and the applicable application,
infrastructure, content and image suites were run. Added regression checks cover
signup PKCE state, draft refresh, incomplete edits, owner/version isolation,
invalid lines, corrupt storage and submission bounds. A browser fixture exercised
recovery interpolation, its confirmed upper bound, failure reset, editor refresh
and comment deletion.

The first simultaneous API/browser/infrastructure test run failed while Docker
created some DynamoDB Local containers. Those assertions did not run. A subsequent
API run with four file workers passed all 325 tests. This result does not establish
the cause of Docker's HTTP 500 responses. One Linux-specific capture test is
skipped on macOS; the Linux Monitor image checks are reported separately.

The final application checks passed: 325 API tests with four file workers, 76
browser tests, 34 infrastructure tests, 19 content tests, 457 Gateway tests,
53 Monitor tests plus one macOS skip, 21 reference Challenge tests, 3 DNS
Challenge tests, 8 Linux Monitor image tests and 3 Gateway runtime image tests.
Contract and script checks passed separately.

No classroom capacity, cloud-versus-on-premise cost result, educational benefit
or complete browser/model compatibility is established by this checkpoint.
The cloud cost allowance was a target, not measured spend.

## Temporary deployment cleanup

New starts were closed. Both attempts were resolved, recording work was drained,
and temporary teardown used exact trial ownership. The temporary sign-up policy
and recording CORS changes were restored. Durable session data, recordings and
the newly verified learner identity are preserved. Final resource absence must
be verified before reporting the temporary runtime as removed.
