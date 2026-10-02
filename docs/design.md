# Interface design contract

Status: functional design. Framework, terminal emulator library, visual identity, chart
library, and exact layout belong to the frontend team. This file fixes behaviour, not a
mockup.

## Navigation and plans

The primary navigation has Learn, Challenges, and Code Review. Catalogue entries show
title, tier, category, and plan. Code Review entries also show language. Only filters
represented by published content appear. Pro entries stay visible on the Free plan with
a clear locked state. Free Learn pages work without an account.

## Starting a Challenge

Starting a Challenge shows a provisioning state while the environment starts, which can
take tens of seconds. Say that the clock starts only when the terminal is ready. If
capacity is unavailable, show the retry delay and keep the catalogue usable. If the
learner already has an active attempt, offer to resume or end it.

## Challenge workspace

The workspace presents the alert, time remaining, the aggregate recovery indicator, a
terminal, a dashboard, and a timeline. The terminal is the primary control. There is no
action menu. Hints and an optional assistant panel share the workspace. A learner must
be able to complete the Challenge with the assistant closed.

- The dashboard shows request rate, errors, latency, and resource use. Commands appear
  as markers on the charts, and selecting a marker shows the command and its output
  excerpt.
- The timeline lists commands, outages, and recovery signals in time order.
- The recovery indicator shows failing, sustaining with progress, or met. It never names
  individual validators.
- Time is real. Say so plainly: traffic and failures continue while the learner reads,
  waits for the assistant, or is disconnected.
- Releasing a hint needs a confirmation that it is recorded as assistance.
- Ending an attempt needs a confirmation that it cannot be resumed.

## Interaction states

| State | Behaviour |
| --- | --- |
| Provisioning | Show progress, allow leaving the page, poll with backoff |
| Ready | Connect the terminal with a fresh ticket and restore the existing shell |
| Reconnecting | Keep the last dashboard values visible, say that the clock is still running, reconnect with a new ticket |
| Replaced | The attempt was opened elsewhere. Offer to take it back here |
| Assistant proposal | Show the command, rationale, and caution flag. Confirm only at a verified empty prompt. Show `TERMINAL_BUSY` if a command runs, text is partly typed, or prompt state is unknown. Allow manual copying |
| Proposal delivery | Show dispatching, accepted, or unknown. Accepted means the terminal accepted input, not that the command succeeded. Unknown requires checking output, not automatic retry |
| Provider failure | Show the error in the assistant panel only. Terminal, dashboard, and hints are unaffected |
| Interrupted turn | Show that the reply could not finish. Keep the saved state and let the learner send a new request. Do not rerun the old turn |
| Outcome | Stop terminal input, show the outcome and reason, open the debrief when it is ready |
| Debrief pending | Show progress and retry after the returned delay |

Never issue a new start, end, or hint request automatically after an unknown network
outcome. Repeat the same request ID or read the current state.

## Debrief, playback, and retry

The debrief follows the learner's timeline. It separates observed evidence, attempted
checks, and evidence not observed in the recording. It shows possible harmful actions
beside the nearby outage and metrics, without claiming that timing proves the cause.
It gives the root cause, recommended recovery, and sources. Score components are raw
values. An incomplete recording has a visible reason and no numeric score. Missing
records are not shown as learner mistakes. Do not invent a combined grade.

Playback is a timeline with a scrubber and speed control. The terminal recording plays
in step with the metric charts and timestamped configuration and log capture intervals.
Show the capture times, and do not imply that the linked command caused every change.
Key evidence, possible harmful actions, outages, and the start of recovery are
highlighted and can be reached from a list. Playback never starts an environment.

Retry is labelled "Retry in a fresh environment". Retries are labelled separately in
history and progress. The first attempt and its score never change, and a retry result
is never presented as an improvement to the first attempt.

## Code Review

Show the context and a readable diff with stable anchors for file, side, and line.
Learners flag lines with the mouse or keyboard and write a concern for each. Submission
is final for that submission. The results show each finding as found or missed, with its
explanation beside the learner's concerns. Unmatched flags appear neutrally, without a
penalty. Never show a grade for written concerns. An assistant panel can explain the
released findings after submission.

## Accessibility and responsive behaviour

All controls work with a keyboard and have visible focus. The terminal offers a
screen-reader mode and a documented shortcut that moves focus out of the terminal
without sending keys to the shell. Labels and status never depend on colour alone.
Charts give units, legends, and a table alternative. Diffs, logs, and terminal output
scroll horizontally rather than shrinking text. On narrow screens, switch between
terminal, dashboard, and timeline with labelled tabs and preserve context. Respect
reduced-motion preferences.

## Frontend data boundary

Consume the public contract only. Never import Challenge manifests, review bundles, or
other files from `content/`. Do not calculate recovery, outcomes, evidence, or scores in
browser code. Displayed recovery state comes from the gateway and the API.
