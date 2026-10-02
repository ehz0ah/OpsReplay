# Product requirements

Status: product direction from the [preliminary report](reports/preliminary/README.md),
version 5, adopted as the repository source of truth on 25 September 2026. It replaces
the earlier simulated-incident direction. Proposed technical defaults appear in the
[decision register](decisions/README.md).

## Problem and intended outcome

Students and junior engineers need to practise responding to production failures before
they are responsible for live services. Reading an incident report explains what
happened, but does not require investigating incomplete evidence or deciding how to
recover. In a real incident a decision can also change the problem: a fix may give
temporary relief, cause another failure, or make recovery harder.

OpsReplay adapts Google's Wheel of Misfortune for individual practice in a browser. Each
Challenge runs real services in an isolated cloud container with one planted
misconfiguration. Learners diagnose with production tools, repair real configuration
files, and see consequences that follow from real system behaviour. Automated checks
confirm recovery. Afterwards they can play back their session beside the logs and
metrics, or retry in a fresh environment. Stronger diagnosis and recovery judgement is
the intended benefit, which the evaluation will assess. It is not a claim of market
uniqueness.

## Audience

Primary users are computer science students and junior software, DevOps, platform, and
site reliability engineers. Institutions may license Pro access per seat for a class or
training cohort. Hiring assessments and enterprise incident ingestion are outside the MVP.

## Requirements and acceptance

| ID | Requirement | Acceptance |
| --- | --- | --- |
| P01 | Freemium access | Free includes a limited set in every mode, mostly Easy, and Free Challenges include the full debrief and playback. Pro unlocks the expanded set, Medium and Hard, more Code Review languages, and longer Challenge sessions. The server checks the current plan for new access and the saved access grant for an existing attempt or submission |
| P02 | Learn library | Entries give a category, a team-written summary, lessons, a link to the official incident report, and related exercises. Free entries are static pages. Pro entries are returned only after an entitlement check |
| P03 | Tiered practice | Challenges and Code Review use Easy, Medium, and Hard, reflecting evidence ambiguity, service dependencies, and defect subtlety. Tier and language filters list only published values |
| P04 | Isolated environment | Starting a Challenge launches a dedicated task from the Challenge's pinned images. No other learner, task, or the internet can reach it |
| P05 | Real investigation | Each attempt begins with an alert. The learner has a root shell with standard tools, service logs, and configuration files, plus a dashboard of request rate, errors, latency, and resource use with commands marked on the timeline |
| P06 | Real consequences | There is no fixed action list. Any valid fix restores service. Traffic continues throughout, so failed requests accumulate. Each authored trap behaves as its Challenge states |
| P07 | Automated recovery | Validators define recovery, such as checkouts succeeding for 60 consecutive seconds. The attempt succeeds when all pass and fails at the time limit |
| P08 | Tamper-resistant recording | The gateway saves terminal output and monitor data outside the learner's reach. Saved records cannot be changed by the learner. Source output and watched files remain learner-controlled. Monitor isolation must pass the security tests |
| P09 | Scoring and debrief | Raw components are time to recovery, failed requests, investigation effort, and observed outages, without asserted causation. Reduced impact counts before full recovery. The debrief separates observed, attempted, and not-observed evidence. It shows measured consequences, possible harmful actions, the root cause, and recommended recovery. Captures show state over a recorded interval, not proof of what one command changed. Incomplete recordings have no numeric score |
| P10 | Playback and retry | After the debrief, the attempt plays back as a timeline, with the recording in step with timestamped logs, metrics, and configuration captures, and observed evidence and possible harmful actions highlighted. A retry runs in a fresh task, is labelled separately, and never changes the first attempt or its score |
| P11 | Code Review | Learners flag risky lines and write a concern for each. Flagged lines are matched against reference ranges to report found and missed issues and reveal explanations. Written concerns appear beside the reference and are not graded |
| P12 | Optional AI support | The assistant explains output and concepts from recent commands and output, visible metrics, and released hints. It may propose a command, which runs only after the learner confirms it. The planted fault, validators, and unreleased hints stay outside the prompt. It never sets scores or grades free text. Every mode works if the provider fails |
| P13 | Ownership and access | Every session and submission belongs to one authenticated learner. The server checks ownership and the applicable access grant on every request. Plan expiry does not prevent ending an existing attempt or reading its saved result |
| P14 | Reliable lifecycle | Retries, interrupted writes, and provider failures never launch a duplicate task or repeat a score penalty. Every ended session leaves no running task. Reconnecting restores the same shell |
| P15 | Evaluation | Record scenario validity, isolation, performance, LLM accuracy and cost, cloud cost against on-premise, and a 5 to 10 person formative pilot with stated limits |

Requirements apply to the complete MVP. The first implementation slice proves P04 to P10
and P13 to P14 for one reference Challenge before Learn and Code Review are added.

## Initial Challenges

| Challenge | Tier | Planted misconfiguration | Why action order matters |
| --- | --- | --- | --- |
| [Wrong upstream port](../content/challenges/wrong-upstream-port/challenge.json) | Easy | nginx `proxy_pass` targets port 8081, but the app listens on 8080, so users see 502 errors | Editing `nginx.conf` without `nginx -t` risks a syntax error. A reload fails safely, but a restart stops the proxy |
| [Stale DNS record](../content/challenges/stale-dns-record/challenge.json) | Medium | The CoreDNS zone maps `api.internal` to the retired API address, which nginx cached at startup | The fix needs an nginx reload. Restarting nginx while the zone fails to load takes the site offline |
| [Connection exhaustion](../content/challenges/connection-exhaustion/challenge.json) | Hard | Proposed missing-index and connection-pressure scenario. Pool limits are capacity, not measured demand | The worker model, workload, and job-worker failure must be demonstrated before this draft can be published |

These manifests are synthetic drafts. The reference Challenge for the first slice is an
open choice in the [decision register](decisions/README.md).

## Scope boundaries

The MVP includes a small curated library, three modes, a web interface, accounts, plans,
progress, optional AI support, and deployment evaluation. Exercise counts, languages,
scoring weights, model choice, and prices remain open.

Do not add multiplayer or team exercises, company postmortem upload, automatic scenario
generation, MCP, an assistant that runs commands without confirmation, video or image
generation, a graphical authoring tool, hiring features, an instructor dashboard, or
multi-Region deployment. Environments have no internet access, no privileged mode, and
no nested Docker or Kubernetes.

## Commercial model

OpsReplay uses a freemium model across all three modes. The paid value is the authored
practice experience. Limits matter most for Challenges, because each session runs its own
container. Content development, container compute, and language-model use are the main
costs. Prices and willingness to pay have not been validated. The pilot assesses
learning value and interest in the expanded set, while system measurements estimate the
cost of delivering a session.

The prototype represents plans through server-side grants. Payment collection, renewals,
tax, and institutional seat administration are not required to prove the product. A
production billing system needs a separate decision.

## Quality criteria

- The same image version and commands produce the same qualitative result: the fault is
  present at start, each trap behaves as stated, and the reference fix recovers.
  Repeated runs measure the timing variance that real services introduce.
- Playback of a run matches its recorded output, logs, and metrics.
- The dashboard, timeline, debrief, and playback use the same recorded data.
- Every mode works without the LLM.
- The same images run under local Docker and on Fargate.
- Keyboard access, text labels, readable charts, a screen-reader-friendly terminal mode,
  and clear pending and error states are part of the interface acceptance criteria.
- No throughput, learning, or reliability claim is published before measurement.
- Public source code is not an assessment secrecy boundary. Runtime access and prompt
  boundaries still protect the intended learner experience.

## Success evidence

The first demo shows one complete Challenge: start, investigation, a harmful action and
its real effect, recovery, debrief, playback, and a retry in a fresh task. The learner
can explain the outcome using recorded evidence. The system evaluation verifies scenario
validity over repeated runs, isolation, duplicate-safe start and end, and that no task
outlives its session. The pilot reports usability problems and early learning evidence
without treating its small sample as proof of broad effectiveness.
