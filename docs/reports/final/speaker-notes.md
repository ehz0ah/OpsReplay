# Presentation speaker notes

Status: draft script and time budget. No timed rehearsal has been completed.
Assign Blocks A to F to the six team members. Each block requires one speaker.
The totals below are planned time, not measured presentation duration.

| Block | Slides |  Time | Purpose                                            |
| ----- | ------ | ----: | -------------------------------------------------- |
| A     | 1–3    |  90 s | Problem, learner and investigation mechanism       |
| B     | 4–5    |  90 s | Free/Pro offer and contribution assumptions        |
| C     | 6–7    | 120 s | Architecture and duplicate-safe lifecycle          |
| D     | 8      | 240 s | Actual Challenge demo                              |
| E     | 9–10   | 120 s | Learn, Code Review, upgrade and optional assistant |
| F     | 11–15  | 240 s | System evidence, cost, learner study and limits    |

Total: 900 seconds. Slides 16–18 are Q&A backups and are not part of the timed
sequence. Ten minutes of Q&A follows the presentation.

## Block A

**Slide 1, 20 seconds.** “OpsReplay lets students and junior engineers practise a
production failure in a browser. They investigate real services, repair the fault,
then review measured results and their recorded path.”

**Slide 2, 40 seconds.** Explain the gap between reading a postmortem and choosing
an investigation under incomplete evidence. State the target user. Google SRE
already uses incident drills; the category is established. OpsReplay's learning
benefit is an evaluation question, not a proven result.

**Slide 3, 30 seconds.** Walk through the loop. Real commands affect real services.
External checks establish recovery. Debrief and playback make reflection possible.
Retry means a fresh task; the first saved result stays fixed.

## Block B

**Slide 4, 45 seconds.** Free includes a complete sample and full feedback. Pro's
S$12 price is a proposal for additional content and time. The catalogue is small,
so avoid content-parity claims. Show the server-owned fixed demo grant. It does
not collect payment or create a subscription.

**Slide 5, 45 seconds.** Explain contribution versus operating profit. The base
model gives S$9.19 contribution and 106 subscribers for the stated operating
allocation. Nineteen is infrastructure-only break-even. Mention six paid runtime
hours and Free subsidy assumptions. Heavy use and real staffing can change the
result; no unlimited-runtime promise or measured-profit claim is supported.

## Block C

**Slide 6, 65 seconds.** Trace the browser, identity/API, private Gateway and
attempt. Distinguish managed state/recording from per-attempt services. Each action
has its own deployed Lambda and role. Functions reuse modules, not other Lambda
invocations. Describe the no-task-role/no-internet Challenge boundary.

**Slide 7, 55 seconds.** A receipt and immutable arguments precede launch. A lost
response resumes the same attempt. A fixed outcome and cutoff precede drain,
task stop and result publication. Incomplete data has no numeric score. Existing
tests are evidence for specific behaviours, not every possible managed failure.

## Block D

**Slide 8, four minutes.** Switch to the actual application. Follow [demo.md](demo.md).
Use an agent-owned rehearsal account and an approved runtime window. Show briefing,
ownership, evidence, repair, continued recovery, debrief and playback.

Measure start-to-ready and result-preparation time in rehearsal. If these exceed
the allotted live segment, start the fresh attempt during Block C and state that
it was started then. Show the same active attempt in Block D. Do not present a
retained completed attempt as a fresh live start. Explain that the incident clock
continues while navigating.

During the 60-second recovery interval, explain measured service impact and the
reason for sustained checks. Avoid silence or fast-forwarding a live timer. If
runtime is unavailable, switch to the redacted recorded fallback and label its
revision/date. A backup recording is not created by these notes.

## Block E

**Slide 9, 75 seconds.** Show an inline concern, save/refresh and the result/history
flow. Line ranges are matched deterministically; written concerns are not graded.
Show a Learn entry and the demo access difference if time allows.

**Slide 10, 45 seconds.** Explain public evidence context, typed proposal and
separate confirmation. The assistant cannot determine scores or service truth.
State the measured baseline: 18 completions from 19 attempts, with four unsupported
fact replies in manual review. Two deployed calls completed in 8.57 and 6.64 seconds;
confirmation and repeated receipts counted once. The account is permitted for the
demo; no enforced billing cap or accuracy guarantee is claimed. Use the assistant
only within the next approved request/time bounds. Do not present fixtures as
provider output or the tool-only fallback as a generated explanation.

## Block F

**Slide 11, 50 seconds.** The 450 GETs measured a small read mix with one/two
workers. State p50/p95 and the scope. These calls did not start tasks or drive
terminals. They establish neither classroom capacity nor production concurrency.

**Slide 12, 65 seconds.** Cloud has idle Gateway, ALB and endpoint costs. The
on-premise model also needs identity, transactional state, recording, durable
timers and deployment operations. Show the cost sensitivity and how equal labour
with no port effort changes the result. The table is a projection. Qualified
host capacity, measured power and final charges remain required.

**Slide 13, 50 seconds.** Explain the five-to-ten-person formative protocol and
why the assistant stays off. Difficulty differs across the two incidents;
counterbalancing does not remove that difference. Replace the missing-results
content only after real data and manual rubric scoring exist. Do not fill blank
scores from an agent or the owner's informal trial.

**Slide 14, 45 seconds.** State the completed learner loop and exact remaining
gates. Source remediation does not establish complete image clearance. Before
the final presentation, replace this draft status with the actual tested status;
do not conceal a failed or unperformed evaluation.

**Slide 15, 30 seconds.** Restate the learner workflow, show the public code URL
and acknowledge AI assistance. The team must add its own learning statement to
the report. Do not invent individual learning or contribution claims.

## Rehearsal record

After a complete rehearsal, record actual segment times, source revision, exact
runtime configuration, demo outcome, deviations and cleanup evidence privately.
Shorten the script if the total exceeds 15 minutes. Check the fallback recording
for account IDs, credentials, personal information and private provider text.
Keep the working-draft footer until required results and team statements are
complete. Export the completed deck as `Slides.pdf`.
