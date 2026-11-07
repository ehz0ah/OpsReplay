# OpsReplay startup pitch script

Companion to the [PowerPoint deck][pitch-deck]. Each speaker has 2 minutes 30 seconds. Speaker 3 leads the demo on slide 10. Italicized text gives presenter cues. Times are rehearsal targets.

| Speaker | Slides | Time | Assignment |
| --- | --- | --- | --- |
| 1 | 1 to 4 | 0:00 to 2:30 | The hook, problem and customer |
| 2 | 5 to 9 | 2:30 to 5:00 | Learning evidence and product overview |
| 3 | 10 | 5:00 to 7:30 | Demo |
| 4 | 11 to 13 | 7:30 to 10:00 | Competitive advantage and positioning |
| 5 | 14 to 17 | 10:00 to 12:30 | Growth, pricing and operating costs |
| 6 | 18 to 20 | 12:30 to 15:00 | Prototype and interview close |

## Speaker 1 | The hook, problem and customer | 0:00 to 2:30

### Slide 1. AI-generated code at Google | 0:00 to 0:35

Think of the last change an AI agent wrote for you. Who decided it was safe to ship? In April, Google reported that AI generated three quarters of its new code and engineers approved it. Now imagine the change goes live. The shop still loads, but nobody can place an order. Where would you look first?

**Source note.** [Google Cloud Next, April 2026](https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/cloud-next-2026-sundar-pichai/)

### Slide 2. Keeping an evolving codebase working | 0:35 to 1:15

Researchers at Alibaba and Sun Yat-sen University tested agents on 100 maintenance tasks drawn from real repositories. For most models, fewer than one in four tasks stayed free of regressions through every round of changes. A regression means a test that used to pass now fails. It’s the question behind every proposed fix: what else relied on the behaviour we just changed?

**Source note.** [Chen et al., SWE-CI, §4.3, April 2026](https://arxiv.org/html/2603.03823v4). The authors evaluated 20 models. Two exceeded a 50% zero-regression rate.

### Slide 3. When an agent has to find the fault | 1:15 to 1:55

Finding the fault is a separate challenge. IBM and Artificial Analysis gave agents snapshots of 59 reliability incidents. At launch, the best diagnosis score was 47%. To score well, an agent had to identify all the responsible components without adding wrong guesses. An engineer still has to decide which signal to trust and whether a repair will actually let customers buy again.

**Source note.** [IBM and Artificial Analysis, ITBench-AA, May 2026](https://huggingface.co/blog/ibm-research/itbench-aa). The metric is average precision at full recall.

### Slide 4. Who needs incident practice? | 1:55 to 2:30

Our first users are computing students and junior engineers preparing for their first on-call shift. Reliability engineers can also rehearse unfamiliar incidents. A systems instructor gives us a way to reach a whole cohort at the moment this skill matters. The next question is what we want learners to get better at.

**Source note.** OpsReplay product requirements, Audience and P01.

## Speaker 2 | Learning evidence and product overview | 2:30 to 5:00

### Slide 5. How developers build a mental model | 2:30 to 3:02

Think of a mental model as your working picture of how a request moves through a system. Li and Coblenz watched 12 developers tackle 17 debugging tasks. Developers revised that picture as they traced code and ran it. At checkout, the question becomes concrete. Did the order reach the next service, and what evidence would tell us?

**Source note.** [Li and Coblenz, A Grounded Theory of Debugging in Professional Software Engineering Practice](https://arxiv.org/abs/2602.11435). Qualitative observation of seven professional developers and five professional live-coding streamers. The study did not test a training intervention.

### Slide 6. What incident practice can teach | 3:02 to 3:35

In a cybersecurity exercise with 50 students, mean test scores rose from 62% before training to 83% afterwards. The scores were specific to that exercise. For OpsReplay, the design idea is straightforward: give the learner a failure, let them choose a first check, and let them see what happened. Here’s how a Challenge puts that into practice.

**Source note.** [Glas, Vielberth and Pernul, Train as you Fight, CHI 2023](https://epub.uni-regensburg.de/54029/1/3544548.3581046.pdf). The study measured scores immediately before and after a cybersecurity exercise.

### Slide 7. Inside an OpsReplay Challenge | 3:35 to 4:10

OpsReplay starts with a customer-visible symptom in a private lab running real services. The learner chooses what to inspect, makes a repair and checks whether checkout works again. Then they can replay their decisions alongside the service signals or try a different approach in a fresh lab.

**Source note.** OpsReplay product requirements, P04 to P11.

### Slide 8. Why did checkout fail? | 4:10 to 4:37

*Show the real Challenge workspace screenshot. Point to the symptom and one piece of visible evidence.*

This is the learner’s starting point. The page loads, but an order fails. The terminal and service signals give the learner a way to narrow down where the request stopped before they change anything.

### Slide 9. Did the fix work? | 4:37 to 5:00

*Show the real debrief or playback screenshot. Point to the observed outcome, then hand over to the demo speaker.*

This is what the learner can revisit afterwards. The debrief records the outcome, and playback lets them compare a decision with what the service did around that time. Let’s follow one attempt in the demo.

## Speaker 3 | Demo | 5:00 to 7:30

### Slide 10. Demo | 5:00 to 7:30

*Before the talk, cue a real recorded run or prepare a working lab at the start of the incident. Use the actual observations and outcome from that run. The times below are elapsed demo time.*

**0:00 to 0:20 | Show the symptom**

*Open the prepared learner workspace or a recording of an actual run. Show the checkout symptom visible in that attempt.*

Here’s the customer problem. I’ll follow this attempt from the first sign of failure to the check that tells us whether checkout recovered.

**0:20 to 0:55 | Choose a first check**

*Point to one service signal and one relevant terminal observation. Describe exactly what they show.*

I want to find where the request stopped. This is the clue I’d use to choose which service to inspect next.

**0:55 to 1:40 | Follow the repair**

*Show the recorded investigation and change, or perform the rehearsed repair in the prepared lab. Explain the reason for that action.*

Before I make a change, I want a way to tell if it helped. The question I’ll come back to is whether a customer can place an order.

**1:40 to 2:15 | Check the result**

*Show the actual recovery check and debrief. Say whether the observed attempt recovered, and point to the evidence for that outcome.*

Here’s what the customer-facing check recorded. This is how I would decide whether to keep investigating.

**2:15 to 2:30 | Replay and hand off**

*Highlight one decision on the timeline, then return to the deck.*

That’s the decision I’d revisit. In an interview, I can now show exactly why I made it.

## Speaker 4 | Competitive advantage and positioning | 7:30 to 10:00

### Slide 11. Competitive advantage | 7:30 to 8:20

You just saw checkout recover. Now imagine two candidates who both got it working. One restored service quickly. The other restarted a healthy service first and more orders failed while they investigated. A final success indicator looks the same for both. OpsReplay records failed requests and time to recovery. A candidate can use those observations to explain what their approach cost customers and what they would check earlier the next time.

**Source note.** OpsReplay product requirements P05 to P10. The two-candidate example illustrates the product and describes no measured learner outcomes.

### Slide 12. Where OpsReplay fits | 8:20 to 9:10

SadServers has live troubleshooting, progressive clues and a solution check. KodeKloud offers validated DevOps tasks and repeat attempts. Those are established reasons to use either platform. Our specific offer is for an engineer who needs to explain an incident afterwards. They can inspect customer impact, revisit the signals available when they made a choice, and try a different recovery while keeping the first result. That combination gives them concrete material for an interview answer.

**Source note.** [SadServers FAQ](https://sadservers.com/faq) and [KodeKloud 100 Days of DevOps](https://kodekloud.com/100-days-of-devops). OpsReplay product requirements P05 to P10. Comparison uses documented workflows.

### Slide 13. What replay adds | 9:10 to 10:00

Replay earns its place when the learner can answer a question about timing. Did the errors start before I ran that command? Had requests already begun to recover when I changed the configuration? The command, logs and service metrics share a timeline, so the learner can inspect their sequence. A retry starts fresh and keeps the original debrief. That lets someone try an earlier check and see how the two attempts differ. A free first incident includes that whole experience. Here’s what students could pay for next.

**Source note.** OpsReplay product requirements P09 and P10. Events that occur close together in a recording do not establish causation.

## Speaker 5 | Growth, pricing and operating costs | 10:00 to 12:30

### Slide 14. A free first incident | 10:00 to 10:30

A free learner can investigate an incident, review the debrief, replay the timeline and retry. We’re using S$11.99 per month as the placeholder Pro price for more exercises and longer sessions. We haven’t collected payments. Our model starts with an acquisition assumption: how many new learners might try that first incident each week?

**Source note.** S$11.99 is the pitch pricing assumption. Product scope includes free playback, retry and a future per-seat institutional offer.

### Slide 15. How many learners could we reach? | 10:30 to 11:10

Start with 25 new direct users per week. Over 52 weeks, that gives 1,300 distinct sign-ups. We keep word of mouth simple: assume each group of four direct users brings in one new classmate who signs up. That adds 325 referrals, for 1,625 first-year users. Each referred user counts once, and we stop at the first referral. These are acquisition assumptions we would track against actual sign-ups.

**Source note.** Direct sign-ups = 25 × 52 = 1,300. First-generation referral sign-ups = 1,300 ÷ 4 = 325. Total = 1,625. The 25 weekly direct sign-ups exclude referrals.

### Slide 16. What those sign-ups could earn | 11:10 to 11:46

Suppose 15% of those 1,625 sign-ups are active paid subscribers at year-end. That gives about 244 subscribers, allowing for both upgrades and cancellations. At S$11.99 per month, their subscription revenue would be about S$2,926 a month. Holding that level for twelve months gives a projected annualized run rate of S$35,107. The amount actually collected during year one would depend on when people joined and how long they stayed.

**Source note.** Illustrative projection. 1,625 × 15% = 243.75, rounded to 244 subscribers. Year-end MRR = 244 × S$11.99 = S$2,925.56. Exit ARR = S$2,925.56 × 12 = S$35,106.72.

### Slide 17. Would that cover our costs? | 11:46 to 12:30

In this scenario, yes. Our budget allocates about S$972 per month to shared costs, content, support and acquisition. Each paying subscriber contributes about S$9.18 after estimated delivery costs, free use and payment fees. The budget breaks even at 106 subscribers. At 244, the monthly contribution is about S$2,239, leaving roughly S$1,267 above that budget. That margin depends on reaching the assumed paid uptake and keeping lab usage near the modeled level. Engineering payroll is outside this budget.

**Source note.** October pricing model recalculated at S$11.99. Per paid subscriber: S$1.8208395 variable delivery and free subsidy, S$0.99159 assumed payment fees, S$9.1775705 contribution. Fixed allocation S$972.066855/month. At 244 paid, contribution S$2,239.33 and modeled surplus S$1,267.26/month. The base assumes six paid lab hours/month and five active free users per payer.

## Speaker 6 | Prototype and interview close | 12:30 to 15:00

### Slide 18. What we have tested | 12:30 to 13:20

In a temporary AWS deployment, the team started a Challenge, repaired a real service, opened the debrief, replayed the attempt and retried in a fresh environment. That verified the path behind the demo. The deployment was taken down after testing. The updated build still needs qualification before the runtime can reopen. The reason to build this workflow is the kind of answer it lets an engineer give when someone asks how they diagnosed an incident.

**Source note.** OpsReplay README and cited AWS checkpoints. Runtime status is from the 4 November 2026 project checkpoint.

### Slide 19. An interview answer you can defend | 13:20 to 14:10

Think about three follow-up questions an interviewer could ask. First, where did the request stop? Second, which clue made you change that service? Third, how do you know the customer could buy again? In OpsReplay, those questions connect to specific moments in your attempt. You can show what you observed, why you acted and what the recovery check recorded. That’s a more concrete answer than listing the commands you know.

**Source note.** Interview prompts illustrate how a candidate can explain their own Challenge attempt.

### Slide 20. Checkout is down. What do you check first? | 14:10 to 15:00

Picture the interview. The storefront loads, but every order fails. The interviewer asks, “What do you check first?” With OpsReplay, you can answer from an incident you actually worked through. You can describe what you saw, which dependency you tested, and how you knew the customer could buy again. Now picture your first on-call shift. It’s the same question, and this time a customer is waiting. What would you check first?

**Source note.** Closing scenario for illustration.

<details>

<summary>Hidden appendix: audience questions and AWS architecture (slides 21–26)</summary>

Use these slides during Q&A. The timed presentation ends on slide 20.

### Slide 21. Audience and alternatives

**Who would try OpsReplay first?**

A student preparing for a systems interview or a junior engineer approaching a first on-call shift. One free incident gives them a concrete decision to explain. We would start with interview-preparation groups. A useful demand signal is whether someone voluntarily starts a second incident.

**Why use this if SadServers and KodeKloud already offer labs?**

OpsReplay lets learners line up their own commands with failed requests and recovery time, then try a different repair while preserving the first result. SadServers offers live troubleshooting and KodeKloud offers structured tasks and checks. Our case for interview preparation is that the learner can show the reasoning behind a specific repair.

### Slide 22. Demand and pricing

**Where do the 25 weekly users and 15% paid uptake come from?**

Both are planning assumptions. The scenario starts with 1,300 direct sign-ups in a year, adds 325 distinct referrals and assumes 244 users are paying at year-end. The referral assumption is one additional user per four direct users, counted once. The 15% figure includes both upgrades and retention through year-end.

**What would justify paying S$11.99 a month?**

Free includes one complete incident with debrief, replay and retry. Pro is a proposed offer for learners who want more incidents and longer sessions. We would measure the share who start another case, upgrade and remain subscribed. The prototype demonstrates access levels and has collected no subscription revenue.

### Slide 23. Revenue and costs

**How much of the S$35,107 would we actually earn in year one?**

S$35,107 annualizes one projected month at 244 subscribers. First-year receipts depend on when each subscriber joins and how long they stay. At the S$11.99 placeholder, 244 subscribers would generate S$2,925.56 per month. Multiplying by twelve gives an exit run rate of S$35,106.72.

**What happens if far fewer people pay?**

The pitch model needs 106 paying subscribers to cover its S$972 monthly budget. At 5% uptake, about 81 subscribers would leave a shortfall of roughly S$229 a month. This sensitivity uses 1,625 sign-ups and S$9.1775705 contribution per paid subscriber. It holds usage and costs fixed. Heavy lab use would lower contribution, and the budget excludes engineering payroll.

### Slide 24. Recovery and AI

**How do you know the learner fixed the incident?**

A separate monitor tests the customer-facing operation. In the checkout exercise, recovery requires successful checkouts for 60 consecutive seconds. The check can accept a valid alternative repair. Terminal output alone cannot establish recovery. The debrief reports time to recovery, failed requests and observed actions.

**Could the AI assistant solve or grade the exercise?**

It can explain visible evidence and suggest a command. The learner confirms the exact command before it runs. The monitor determines recovery, and the learner can complete the lab with AI off. The optional model sees public evidence. Hidden faults, validators and unreleased hints stay outside its context. Scores come from the platform’s recorded evidence.

### Slide 25. Safety and scale

**Why give a learner a real shell?**

Commands need real consequences. Each attempt runs in a private Fargate task without a task IAM role or internet route. Only the Gateway can connect to the task. The Gateway validates the terminal ticket, relays the shell traffic and records evidence outside the learner’s writable environment. The following diagram shows the access path.

**What has been tested, and could a whole class use it?**

The report documents six hosted attempts with at most two concurrent. All six recordings finalized. Capacity for a full class remains unmeasured. The November campaign verified recovery, playback and cleanup. Replacing one Gateway also disrupted another active attempt, an observed reliability limit. Hosted checks show the workflow ran. Learning gains and classroom capacity remain unmeasured.

### Slide 26. AWS architecture

The slide reproduces Figure 2 from page 5 of the [final report](https://github.com/ehz0ah/OpsReplay/blob/2cd24a5cb9b2766fe72160646f3e5fe628bb0cfb/docs/reports/final/Final.pdf#page=5). Follow the terminal connection from the browser through CloudFront to the Gateway and then to the per-attempt task.

</details>

[pitch-deck]: <OpsReplay Business Pitch.pptx>
