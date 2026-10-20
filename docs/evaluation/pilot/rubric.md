# Manual learning rubric

Score each baseline, post-condition and transfer response on four dimensions, 0 to 2
each, total 0 to 8. Leave missing responses null. Score the reasoning, not writing
style or exact command syntax. The assistant must not grade these answers.

| Dimension         | 0                                            | 1                                            | 2                                                                                                          |
| ----------------- | -------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Evidence          | Guess or unrelated signal                    | One relevant signal without comparison       | Compares proxy target with actual service listener; DNS case also compares resolution                      |
| Causal chain      | Incorrect or absent                          | Correct symptom or partial chain             | Explains stale target, refused connection and request failure; DNS case includes retained proxy resolution |
| Safe mitigation   | Harmful or unsupported change                | Valid change but missing validation or order | Repairs the right source, validates before applying and explains reload/start implications                 |
| Recovery evidence | Declares success from one superficial signal | Tests service reachability only              | Verifies the affected business operation and sustained success, distinguishing DNS or status alone         |

For upstream answers, full evidence credit compares nginx error/config target 8081
with actual listener 8080. Equivalent direct API and proxy comparisons are valid.
Full mitigation credit requires valid configuration before reload, or before start if
the proxy stopped. Do not demand the example `sed` command.

For DNS answers, full causal credit identifies both the stale record and a proxy that
retained its startup resolution. Full mitigation credit restores valid DNS, verifies
the answer, validates nginx and then reloads or starts it. An alternative verified
repair is acceptable if the learner explains its effects.

Transfer uses the same dimensions with the changed addresses or ports. Accept a
qualified hypothesis when the question gives incomplete evidence. Reject certainty
about unobserved facts. Do not subtract credit because the participant admits a limit.

Two team members score responses independently using pseudonyms. Where practical,
hide condition and timing labels during scoring. Resolve disagreements by referring to
the rubric and record both original scores plus the agreed score. Do not revise the
rubric after seeing condition results without reporting the change.

Report dimension scores and totals, plus each participant's post-minus-baseline change
within each incident. An interactive-minus-static comparison mixes incidents of
different difficulty and is descriptive only. Include completion, hints and exposure
beside the scores. Numeric game score is a separate operational result, not this
learning measure.
