# Facilitator procedure

Use the assignment row for the participant. Keep the same browser, materials, time
limits and prompts for every participant. Do not teach the solution during a condition.

| Phase           | Time   | Procedure                                                                                                                             |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Introduction    | 5 min  | Explain consent and recording. Record background and prior familiarity with these incidents.                                          |
| Common tutorial | 5 min  | Explain nginx, API, DNS and database roles, terminal input, dashboard units and debrief navigation. Use no planted fault or solution. |
| Condition 1     | 18 min | Baseline questions 3 min, assigned study 12 min, post questions 3 min.                                                                |
| Transfer 1      | 3 min  | Use the matching unseen transfer case. No app or static answer sheet.                                                                 |
| Condition 2     | 18 min | Repeat with the other incident and condition.                                                                                         |
| Transfer 2      | 3 min  | Use its matching unseen case.                                                                                                         |
| Product tasks   | 5 min  | Read Free Learn, locate related practice, open Code Review, flag risky lines, submit and find the saved result in history.            |
| Usability       | 8 min  | Complete SUS, then a short neutral interview.                                                                                         |

The duration is approximately 65 minutes. Record actual times and deviations.

## Interactive study

Use 8 minutes for investigation and repair, then 4 minutes for debrief and playback.
The default Challenge timer is longer; the facilitator applies this study limit.
At eight minutes, ask the learner to end an unresolved attempt through the UI. Do not
shorten the server timer or edit session state. Wait for the saved debrief. Record
finalisation delay separately and pause the four-minute debrief clock until it loads.
If the learner resolves early, keep the remaining investigation time for observing
recovery and explaining evidence. Do not reveal the reference fix.

Hints remain available and their release is recorded. Assistant stays disabled.
If the platform fails, stop the condition, record the failure, and mark its learning
scores missing. Do not repair infrastructure in front of the learner and count the
same run as uninterrupted.

## Static study

Use the appropriate static case for 12 minutes. It contains alert, evidence, unsafe
action, causal explanation and recovery, including information equivalent to the
reference debrief. It has no live terminal or playback. Permit rereading and notes.
The interactive learner can receive less information if they do not investigate or
finish, so record completion and evidence exposure. Equal time alone does not eliminate
this difference.

## Neutral prompts

Use: “Please explain what you are checking” or “What evidence supports that choice?”
Do not use: “Have you checked DNS?”, “Try a reload” or “That is the wrong port.”
For interface trouble, explain only the control's operation and record the help.

Record platform errors, confusion, risky actions, pauses and hints with timestamps.
Do not infer a command caused an outage merely because it came first. Use Monitor
observations and the saved debrief's attribution limits.

After the participant leaves, copy only necessary raw results into restricted storage,
remove exported browser tokens, and check the session reached terminal cleanup. Do not
place names or terminal output in GitHub issues. Report defects with a synthetic or
redacted reproduction.
