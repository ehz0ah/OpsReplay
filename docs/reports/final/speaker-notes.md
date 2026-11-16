# OpsReplay final presentation script

Companion to the [redesigned PowerPoint][deck]. Each of the six speakers has 2 minutes 30 seconds. Slide 6 is hidden and untimed. Slides 22–27 are hidden Q&A material. Italicized directions are presenter cues.

| Speaker | Presenter | Slides | Time |
| --- | --- | --- | --- |
| 1 | Yang Zhi | 1–4 | 0:00 to 2:30 |
| 2 | Kai Xiang | 5–10 | 2:30 to 5:00 |
| 3 | Neeraj | 11 | 5:00 to 7:30 |
| 4 |  | 12–14 | 7:30 to 10:00 |
| 5 |  | 15–18 | 10:00 to 12:30 |
| 6 |  | 19–21 | 12:30 to 15:00 |

## Speaker 1 (Yang Zhi) | The hook, problem and customer | 0:00 to 2:30

### Slide 1. AI-generated code at Google | 0:00 to 0:35

Think of the last change an AI agent wrote for you. Who decided it was safe to ship? In April, Google reported that AI generated three quarters of its new code and engineers approved it. Now imagine the change goes live. The shop still loads, but nobody can place an order. Where would you look first?

**Source note.** Google Cloud Next, April 2026 (https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/cloud-next-2026-sundar-pichai/)

*Before presenting, Neeraj should cue an actual recorded run or open the prepared real lab on the demo laptop.*

### Slide 2. Keeping an evolving codebase working | 0:35 to 1:15

Researchers at Alibaba and Sun Yat-sen University tested agents on 100 maintenance tasks drawn from real repositories. For most models, fewer than one in four tasks stayed free of regressions through every round of changes. A regression means a test that used to pass now fails. It’s the question behind every proposed fix: what else relied on the behaviour we just changed?

**Source note.** Chen et al., SWE-CI, §4.3, April 2026 (https://arxiv.org/html/2603.03823v4). The authors evaluated 20 models. Two exceeded a 50% zero-regression rate.

### Slide 3. When an agent has to find the fault | 1:15 to 1:55

Finding the fault is a separate challenge. IBM and Artificial Analysis gave agents snapshots of 59 reliability incidents. At launch, the best diagnosis score was 47%. To score well, an agent had to identify all the responsible components without adding wrong guesses. An engineer still has to decide which signal to trust and whether a repair will actually let customers buy again.

**Source note.** IBM and Artificial Analysis, ITBench-AA, May 2026 (https://huggingface.co/blog/ibm-research/itbench-aa). The metric is average precision at full recall.

### Slide 4. Who needs incident practice? | 1:55 to 2:30

Our first users are computing students and junior engineers preparing for their first on-call shift. Reliability engineers can also rehearse unfamiliar incidents. A systems instructor gives us a way to reach a whole cohort at the moment this skill matters. The next question is what we want learners to get better at.

**Source note.** OpsReplay product requirements, Audience and P01.

## Speaker 2 (Kai Xiang) | Learning evidence and product walkthrough | 2:30 to 5:00

### Slide 5. How developers build a mental model | 2:30 to 3:05

Think of a mental model as your working picture of how a request moves through a system. Li and Coblenz watched 12 developers tackle 17 debugging tasks. Developers revised that picture as they traced code and ran it. At checkout, the question becomes concrete. Did the order reach the next service, and what evidence would tell us?

**Source note.** Li and Coblenz, A Grounded Theory of Debugging in Professional Software Engineering Practice (https://arxiv.org/abs/2602.11435). Qualitative observation of seven professional developers and five professional live-coding streamers. The study did not test a training intervention.

### Slide 6. What incident practice can teach | Hidden · untimed

In a cybersecurity exercise with 50 students, mean test scores rose from 62% before training to 83% afterwards. The scores were specific to that exercise. For OpsReplay, the design idea is straightforward: give the learner a failure, let them choose a first check, and let them see what happened. Here’s how a Challenge puts that into practice.

**Source note.** Glas, Vielberth and Pernul, Train as you Fight, CHI 2023 (https://epub.uni-regensburg.de/54029/1/3544548.3581046.pdf). The study measured scores immediately before and after a cybersecurity exercise.

### Slide 7. Inside an OpsReplay Challenge | 3:05 to 3:45

OpsReplay starts with a customer-visible symptom in a private lab running real services. The learner chooses what to inspect, makes a repair and checks whether checkout works again. Then they can replay their decisions alongside the service signals or try a different approach in a fresh lab.

**Source note.** OpsReplay product requirements, P04 to P11.

### Slide 8. Why did checkout fail? | 3:45 to 4:15

*Show the real Challenge workspace screenshot. Point to the symptom and one piece of visible evidence.*

This is the learner’s starting point. The page loads, but an order fails. The terminal and service signals give the learner a way to narrow down where the request stopped before they change anything.

### Slide 9. Did the fix work? | 4:15 to 4:40

*Point to the resolved attempt and the two figures beside the screenshot.*

Checkout recovered in about 285 seconds. During this attempt, 569 requests failed. If I were explaining the repair in an interview, those are the numbers I’d start with. The debrief lets me revisit which clue I checked and when I acted. Now let’s look at how a learner spots a risk before a change goes live.

### Slide 10. Code Review Challenges | 4:40 to 5:00

*Show the Code Review screenshot. Point to the flagged line, then hand over to Neeraj.*

OpsReplay also has Code Review Challenges. Before a change ships, you review it like a teammate would: flag the line you think is risky and explain why. Then you compare your review with the findings we prepared. Let’s follow one attempt in the demo.

**Source note.** OpsReplay Code Review Challenges (product).

## Speaker 3 (Neeraj) | Demo | 5:00 to 7:30

### Slide 11. Demo | 5:00 to 7:30

*Use a prepared lab or announce that you are showing a recording of an actual run. Cue the recording before the talk. If recovery takes longer than planned, use the real recorded debrief and identify it as such.*

**0:00 to 0:15 | Show the symptom**

*Show the checkout alert and the failed request.*

The storefront loads, but an order fails. I want to find where that request stopped.

**0:15 to 0:40 | Choose the first check**

*Point to a service signal and the corresponding terminal observation from this attempt.*

This observation narrows down which dependency I’ll inspect next.

**0:40 to 1:00 | Apply the repair**

*Show the rehearsed change and apply it by 1:00. If the run is behind schedule, switch to the cued real recording.*

This change follows from the evidence. I’ll judge it by whether a customer can place an order again.

**1:00 to 2:00 | Watch 60 seconds of recovery**

*Show the live service signals. Give the monitor the full 60 seconds of successful checkouts. If the streak breaks, report what happened.*

One successful order is a start. The monitor watches for sustained recovery. While it runs, here’s the signal that made me choose this repair and the check that would make me reconsider it.

**2:00 to 2:30 | Debrief, replay and hand off**

*Show the confirmed outcome if it is ready. Point to one recorded action and the service signals around it. Hand over to Speaker 4 at 7:30.*

The debrief tells us how many requests failed while we worked. The replay lets me show what I knew when I acted. That’s the decision I’d want to explain in an interview.

## Speaker 4 | Competitive advantage and positioning | 7:30 to 10:00

### Slide 12. Two repairs can restore checkout | 7:30 to 8:20

You just saw checkout recover. Now imagine two candidates who both got it working. One restored service quickly. The other restarted a healthy service first and more orders failed while they investigated. A final success indicator looks the same for both. OpsReplay records failed requests and time to recovery. A candidate can use those observations to explain what their approach cost customers and what they would check earlier the next time.

**Source note.** OpsReplay product requirements P05 to P10. The two-candidate example illustrates the product and describes no measured learner outcomes.

### Slide 13. Where OpsReplay fits | 8:20 to 9:10

SadServers has live troubleshooting, progressive clues and a solution check. KodeKloud offers validated DevOps tasks and repeat attempts. Those are established reasons to use either platform. Our specific offer is for an engineer who needs to explain an incident afterwards. They can inspect customer impact, revisit the signals available when they made a choice, and try a different recovery while keeping the first result. That combination gives them concrete material for an interview answer.

**Source note.** SadServers FAQ (https://sadservers.com/faq) and KodeKloud 100 Days of DevOps (https://kodekloud.com/100-days-of-devops). OpsReplay product requirements P05 to P10. Comparison uses documented workflows.

### Slide 14. What replay adds | 9:10 to 10:00

Replay earns its place when the learner can answer a question about timing. Did the errors start before I ran that command? Had requests already begun to recover when I changed the configuration? The command, logs and service metrics share a timeline, so the learner can inspect their sequence. A retry starts fresh and keeps the original debrief. That lets someone try an earlier check and see how the two attempts differ. A free first incident includes that whole experience. Here’s what students could pay for next.

**Source note.** OpsReplay product requirements P09 and P10. Events that occur close together in a recording do not establish causation.

## Speaker 5 | Growth, pricing and operating costs | 10:00 to 12:30

### Slide 15. A free first incident | 10:00 to 10:30

A free learner can investigate an incident, review the debrief, replay the timeline and retry. We’re using S$11.99 per month as the placeholder Pro price for more exercises and longer sessions. We haven’t collected payments. Our model starts with an acquisition assumption: how many new learners might try that first incident each week?

**Source note.** S$11.99 is the pitch pricing assumption. Product scope includes free playback, retry and a future per-seat institutional offer.

### Slide 16. How many learners could we reach? | 10:30 to 11:10

We’ll start with university computer science students, offering one free checkout incident through systems courses and interview-prep groups. Our scenario assumes 25 new direct users each week. Over 52 weeks that’s 1,300 sign-ups. If every four bring in one new classmate, we add 325 referrals, giving 1,625 first-year users. We count each referral once. Direct starts and referral sign-ups are the numbers we’d track to see whether this channel works.

**Source note.** Acquisition assumptions for the pitch. 25 × 52 = 1,300 direct users. 1,300 ÷ 4 = 325 first-generation referrals.

### Slide 17. What those sign-ups could earn | 11:10 to 11:46

Suppose 15% of those 1,625 sign-ups are active paid subscribers at year-end. That gives about 244 subscribers, allowing for both upgrades and cancellations. At S$11.99 per month, their subscription revenue would be about S$2,926 a month. Holding that level for twelve months gives a projected annualized run rate of S$35,107. The amount actually collected during year one would depend on when people joined and how long they stayed.

**Source note.** Illustrative projection. 1,625 × 15% = 243.75, rounded to 244 subscribers. Year-end MRR = 244 × S$11.99 = S$2,925.56. Exit ARR = S$2,925.56 × 12 = S$35,106.72.

### Slide 18. Would that cover our costs? | 11:46 to 12:30

In this scenario, yes. Our budget allocates about S$972 per month to shared costs, content, support and acquisition. Each paying subscriber contributes about S$9.18 after estimated delivery costs, free use and payment fees. The budget breaks even at 106 subscribers. At 244, the monthly contribution is about S$2,239, leaving roughly S$1,267 above that budget. That margin depends on reaching the assumed paid uptake and keeping lab usage near the modeled level. Engineering payroll is outside this budget.

**Source note.** October pricing model recalculated at S$11.99. Per paid subscriber: S$1.8208395 variable delivery and free subsidy, S$0.99159 assumed payment fees, S$9.1775705 contribution. Fixed allocation S$972.066855/month. At 244 paid, contribution S$2,239.33 and modeled surplus S$1,267.26/month. The base assumes six paid lab hours/month and five active free users per payer.

## Speaker 6 | Prototype evidence and interview close | 12:30 to 15:00

### Slide 19. Six AWS attempts produced six complete recordings | 12:30 to 13:20

We’ve shown where the business could go. Here’s what we’ve actually tested. On 1 November, the team ran six attempts on AWS, with up to two running at the same time. All six recordings finalized, and all 41 exported objects matched their checksums. Across the hosted checks, we verified recovery, reopened the debrief, replayed an attempt, and retried in a fresh lab. We took the temporary deployment down afterwards. Those tests give us confidence in this learner workflow. Classroom-scale capacity is still unmeasured.

**Source note.** OpsReplay final report, Hosted Functional and Reliability Tests, 1 November 2026 (https://github.com/ehz0ah/OpsReplay/blob/2cd24a5cb9b2766fe72160646f3e5fe628bb0cfb/docs/reports/final/Final.pdf).

### Slide 20. An interview answer you can defend | 13:20 to 14:10

Think about three follow-up questions an interviewer could ask. First, where did the request stop? Second, which clue made you change that service? Third, how do you know the customer could buy again? In OpsReplay, those questions connect to specific moments in your attempt. You can show what you observed, why you acted and what the recovery check recorded. That’s a more concrete answer than listing the commands you know.

**Source note.** Interview prompts illustrate how a candidate can explain their own Challenge attempt.

### Slide 21. Checkout is down. What do you check first? | 14:10 to 15:00

Picture the interview. The storefront loads, but every order fails. The interviewer asks, “What do you check first?” With OpsReplay, you can answer from an incident you actually worked through. You can describe what you saw, which dependency you tested, and how you knew the customer could buy again. Now picture your first on-call shift. It’s the same question, and this time a customer is waiting. What would you check first?

<details>

<summary>Hidden appendix · audience questions and AWS architecture (slides 22–27)</summary>

### Slide 22. Audience and alternatives

Who would try OpsReplay first?

A student preparing for a systems interview or a junior engineer approaching a first on-call shift. One free incident gives them a concrete decision to explain. We would start with interview-preparation groups. A useful demand signal is whether someone voluntarily starts a second incident.

Why use this if SadServers and KodeKloud already offer labs?

OpsReplay lets learners line up their own commands with failed requests and recovery time, then try a different repair while preserving the first result. SadServers offers live troubleshooting and KodeKloud offers structured tasks and checks. Our case for interview preparation is that the learner can show the reasoning behind a specific repair.

### Slide 23. Demand and pricing

Where do the 25 weekly users and 15% paid uptake come from?

Both are planning assumptions. The scenario starts with 1,300 direct sign-ups in a year, adds 325 distinct referrals and assumes 244 users are paying at year-end. The referral assumption is one additional user per four direct users, counted once. The 15% figure includes both upgrades and retention through year-end.

What would justify paying S$11.99 a month?

Free includes one complete incident with debrief, replay and retry. Pro is a proposed offer for learners who want more incidents and longer sessions. We would measure the share who start another case, upgrade and remain subscribed. The prototype demonstrates access levels and has collected no subscription revenue.

### Slide 24. Revenue and costs

How much of the S$35,107 would we actually earn in year one?

S$35,107 annualizes one projected month at 244 subscribers. First-year receipts depend on when each subscriber joins and how long they stay. At the S$11.99 placeholder, 244 subscribers would generate S$2,925.56 per month. Multiplying by twelve gives an exit run rate of S$35,106.72.

What happens if far fewer people pay?

The pitch model needs 106 paying subscribers to cover its S$972 monthly budget. At 5% uptake, about 81 subscribers would leave a shortfall of roughly S$229 a month. This sensitivity uses 1,625 sign-ups and S$9.1775705 contribution per paid subscriber. It holds usage and costs fixed. Heavy lab use would lower contribution, and the budget excludes engineering payroll.

### Slide 25. Recovery and AI

How do you know the learner fixed the incident?

A separate monitor tests the customer-facing operation. In the checkout exercise, recovery requires successful checkouts for 60 consecutive seconds. The check can accept a valid alternative repair. Terminal output alone cannot establish recovery. The debrief reports time to recovery, failed requests and observed actions.

Could the AI assistant solve or grade the exercise?

It can explain visible evidence and suggest a command. The learner confirms the exact command before it runs. The monitor determines recovery, and the learner can complete the lab with AI off. The optional model sees public evidence. Hidden faults, validators and unreleased hints stay outside its context. Scores come from the platform’s recorded evidence.

### Slide 26. Safety and scale

Why give a learner a real shell?

Commands need real consequences. Each attempt runs in a private Fargate task without a task IAM role or internet route. Only the Gateway can connect to the task. The Gateway validates the terminal ticket, relays the shell traffic and records evidence outside the learner’s writable environment. The following diagram shows the access path.

What has been tested, and could a whole class use it?

The report documents six hosted attempts with at most two concurrent. All six recordings finalized. Capacity for a full class remains unmeasured. The November campaign verified recovery, playback and cleanup. Replacing one Gateway also disrupted another active attempt, an observed reliability limit. Hosted checks show the workflow ran. Learning gains and classroom capacity remain unmeasured.

### Slide 27. One task per attempt

The slide reproduces Figure 2 from page 5 of the final report (https://github.com/ehz0ah/OpsReplay/blob/2cd24a5cb9b2766fe72160646f3e5fe628bb0cfb/docs/reports/final/Final.pdf#page=5). Follow the terminal connection from the browser through CloudFront to the Gateway and then to the per-attempt task.

</details>

[deck]: <OpsReplay_Final_Presentation.pptx>
