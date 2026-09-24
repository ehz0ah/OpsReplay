# Evaluation plan

The project needs system and user evaluation. Results must identify Challenge image
versions, deployment settings, provider and model, workload, and sample size.

## System correctness, reliability, and performance

| Area | Evidence required |
| --- | --- |
| Scenario validity | Scripted runs confirm the fault is present at start, validators fail before the reference fix and pass after it, and each trap behaves as stated. Twenty repeats per Challenge expose flaky environments and measure recovery-time variance |
| Playback | Playback of each reference run matches its recorded output, logs, and metrics |
| Isolation | Tasks cannot reach the internet, other tasks, or AWS credentials. DNS egress is tested separately |
| Access | Users cannot open another learner's session, ticket, recording, or submission, or content outside their plan |
| Lifecycle | Retries, interrupted writes, and provider failures do not launch duplicate tasks or repeat score penalties. Every ended session leaves no running task |
| Visibility | No planted fault, validator, probe, trap, unreleased hint, or review finding appears in responses, errors, prompts, or browser assets |
| Performance | At 10, 50, and 100 concurrent sessions: time to a ready terminal with and without a warm pool, terminal round-trip latency, median and 95th-percentile API latency, errors, and DynamoDB throttling |

Record the action mix and think time. The load points are proposals, subject to the
Fargate vCPU quota. A load client drives terminals through the gateway like a learner.

## LLM accuracy, latency, and cost

A labelled request set specifies context and acceptable commands or explanations. Tests
measure suggestion accuracy, destructive suggestions, unsupported claims, answer
leakage, and teaching accuracy. For each model, record median and 95th-percentile
latency for the full conversational loop and token cost per session. Environment load
tests use simulated responses, labelled as such. Separate real-provider tests run under
a fixed budget.

## Formative pilot

Recruit 5 to 10 computer science students or junior engineers with informed consent.
Each investigates one Challenge, reads its debrief, and reviews the session playback. For
another Challenge of similar difficulty, the learner reads a static explanation of the
evidence, actions, and outcomes. Balance assignment and order where the sample permits,
allow equal study time, and provide equivalent causal information. The AI assistant is
off, isolating the environment and debrief workflow.

Questions before and after each condition assess diagnosis and causal reasoning with a
common rubric. After each condition, learners diagnose a short new scenario and justify a
recovery plan, which tests transfer. Record completion, self-inflicted outages, and
explanation quality. Brief tasks check Learn, Code Review, and optional AI support.
Participants complete the System Usability Scale and a short interview on usability and
playback.

Report individual scores, paired differences, and usability problems. The pilot gives
early evidence to guide improvement. It cannot establish broad effectiveness, long-term
retention, or the separate effect of playback within the full workflow.

## Cloud cost and on-premise comparison

On-demand containers and serverless handlers assume intermittent demand. Compare steady
use and class-sized bursts with an on-premise deployment of the same images, using
measured workloads and published rates.

- AWS: per-session Fargate vCPU and memory, API requests, Lambda, DynamoDB, storage,
  transfer, authentication, and monitoring, plus the ALB, VPC endpoints, and gateway
  service, which cost money even when idle, and any warm pool.
- On-premise: a container host sized for peak class load over its useful life, power,
  networking, maintenance, and staff time.

Both include the same external LLM cost. Report cost per completed session, capacity,
and availability assumptions. Report credits separately and do not assume cloud hosting
is cheaper. The repository has no performance results or cost claims yet.
