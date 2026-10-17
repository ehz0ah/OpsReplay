# Verify browser recovery after review

Run this focused checkpoint after the debrief and telemetry changes are reviewed,
merged and locally checked. Use the existing
[activation runbook](aws-checkpoint-activation.md) for budget, admission and cleanup.
This checklist creates no deployment or credentials itself.

## Preparation

- Pin merged source, tested images and the candidate manifest. Complete publication
  gates before opening admission; do not reuse evidence for a changed image.
- Use one test learner and a second account for access checks. No classroom load.
- Reuse exact browser, API, Cognito, terminal and recording origins.
- Save only safe request/session/task IDs, statuses, timings and screenshots.
  Never save tokens, ticket values, bootstrap secrets or signed URL queries.

## Acceptance

| Case                  | Action                                                                                                                                                | Required result and evidence                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lost start response   | In browser automation, let the real start response complete, then discard it before the application receives it. Reload and recover the saved request | One request receipt, session and task; the journal clears only after the saved response is read. A browser wrapper tests recovery, not actual network failure      |
| Owner boundary        | The second signed-in account requests the first account's status, ticket, hints, end, debrief, timeline and playback                                  | No private data, ticket or signed link; no session mutation. Missing and foreign sessions use the documented denial                                                |
| Evidence feedback     | Run `printf "checking\n"; grep proxy_pass /etc/nginx/nginx.conf; curl ...`, then finish the attempt                                                   | Saved line/output matches the supported inspection in debrief; one recorded line remains one command. Conditional or nested shell forms receive no new proof claim |
| Dashboard             | Open the new reference version during failure and after recovery                                                                                      | Only supported request, error and latency signals are declared; live and saved values agree with Monitor records                                                   |
| Login expiry          | Expire the browser login or block refresh during an existing attempt                                                                                  | Clear sign-in recovery; no silent new attempt or resend of uncertain terminal input                                                                                |
| Recording link expiry | Let issued links expire, then use Refresh recording links                                                                                             | Old object request reports expiry; refreshed links load the same saved content                                                                                     |
| Playback continuation | Use a real recording with more than 25 export references and load every page                                                                          | No missing/duplicate references; final cursor is null. Replay reads saved output without executing input                                                           |
| Timeout               | Leave the bounded test attempt unresolved until its saved deadline                                                                                    | Server records time limit once, drains recording, stops the task and releases the matching lock after finalisation                                                 |

Browser wrappers are allowed only to interrupt delivery of real requests or
responses. They must not fabricate identity, backend outcomes, terminal output or
recording data. Record when interception did not occur; a missed interception is
not a passed recovery test.

## Finish

Close admission, finish or time out the existing attempt, and verify stopped tasks,
empty recording work, released locks and empty dead-letter queue. Capture alarm
states before deleting their stack. Preserve the safe test report, then remove only
checkpoint-owned resources. Keep existing durable resources and normal retention.
Report each case as passed, failed or untested. A small learner pilot follows these
checks and remains separate from performance or learning-effectiveness claims.
