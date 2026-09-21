# Evaluation plan

The project needs both system and user evaluation. Measurements must name content
and engine versions, deployment settings, provider/model, workload, and sample size.

## System evaluation

| Area | Evidence required |
| --- | --- |
| Determinism | Identical state, observations, events, and costs for the same ordered commands |
| Causal behaviour | Early rollback, harmful scaling, temporary relief, delayed recovery, and terminal failure traces |
| Replay | Exact checkpoint restoration, matching repeated suffix, unchanged parent, aligned comparison deltas |
| API reliability | Duplicate identity, payload conflict, concurrent writes, stale action, interrupted commit, reconnect |
| Visibility | No unrevealed evidence through projections, errors, proposals, prompts, or browser assets |
| LLM | Tool and parameter accuracy, invalid calls, unsupported claims, leakage, teaching accuracy |
| Performance | Median/p95 latency, throughput, errors, throttling, cold/warm behaviour |
| Cost | AWS and LLM cost per attempt and per replay under documented action mixes |

Use 10, 50, and 100 independent sessions as proposed load points. State active
request rates and think time, rather than calling idle connections concurrent
work. Engine-only tests exclude provider delay. Run separate bounded tests with
the actual provider. Label simulated provider responses.

## Formative pilot

Recruit 5–10 computer science students or junior engineers with informed consent.
Choose two incidents of similar difficulty. Counterbalance which is interactive
and which is a static explanation as far as the sample permits. Give equal study
time and comparable causal information. Use direct controls without AI for this
comparison.

In the interactive condition, include investigation, debrief, and a checkpoint
replay. Ask for an alternative-action prediction before replay, an explanation
afterward, and a new decision that checks transfer. Use a common rubric for
diagnosis and causal reasoning. Record task completion, harmful actions, usability
problems, SUS, and short interviews. Briefly assess Learn, Code Review, and optional
AI support separately.

Report individual results and paired differences. This is early learning evidence
and usability feedback, not proof of broad effectiveness, long-term retention,
hiring validity, or the isolated contribution of replay.

## Cloud and on-premise comparison

Compare the same service capabilities and external LLM, under steady and burst
workloads. AWS costs include API requests, compute duration, data operations,
storage, transfer, authentication, and monitoring. On-premise costs include
appropriate hardware over its useful life, power, networking, maintenance, and
staff effort. Include availability and capacity assumptions. Report credits
separately and avoid selecting an unrealistic comparison machine.

The preliminary report supplies rationale and method. The final report uses
measured behaviour and dated rates. The current repository has no performance
results or cost claims.
