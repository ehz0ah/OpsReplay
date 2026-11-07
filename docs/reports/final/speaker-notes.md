# OpsReplay startup pitch script

Companion to the [PowerPoint deck][pitch-deck]. Each speaker has 2 minutes 30 seconds. Speaker 3 leads the demo on slide 10. Italicized text gives presenter cues. Times are rehearsal targets.

| Speaker | Slides | Time | Assignment |
| --- | --- | --- | --- |
| 1 | 1 to 4 | 0:00 to 2:30 | The hook, problem and customer |
| 2 | 5 to 9 | 2:30 to 5:00 | Learning evidence and product overview |
| 3 | 10 | 5:00 to 7:30 | Demo |
| 4 | 11 to 13 | 7:30 to 10:00 | Competitive advantage and student interest |
| 5 | 14 to 17 | 10:00 to 12:30 | Growth, pricing and operating costs |
| 6 | 18 to 20 | 12:30 to 15:00 | Proof, pilot and closing hook |

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

There’s a reason to test hands-on practice. In a cybersecurity exercise with 50 students, the mean test score rose from 62% before training to 83% afterwards. We want to learn whether practising a service outage helps a learner choose a better first check when they encounter a different incident.

**Source note.** [Glas, Vielberth and Pernul, Train as you Fight, CHI 2023](https://epub.uni-regensburg.de/54029/1/3544548.3581046.pdf). Related classroom evidence: [Michaeli and Romeike, Improving Debugging Skills in the Classroom](https://cris.fau.de/publications/228376370/). Their school-level study found improved debugging performance following explicit instruction compared with the control group.

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

## Speaker 4 | Competitive advantage and student interest | 7:30 to 10:00

### Slide 11. Competitive advantage | 7:30 to 8:20

You just saw checkout recover. In an interview, the next question is often harder: why did you choose that fix? Two candidates can reach the same result. One can point to the request that failed, explain the clue that changed their mind, and show what happened after the repair. OpsReplay records the attempt so the learner can revisit those moments, practise that explanation aloud, and try a different first check. That’s the advantage we want to offer someone preparing for a systems interview.

**Source note.** OpsReplay product requirements, P09 and P10. Interview preparation is a proposed use case.

### Slide 12. Where OpsReplay fits | 8:20 to 9:10

SadServers gives learners live Linux and DevOps faults to troubleshoot. KodeKloud offers structured tasks with automated checks. Both give engineers hands-on practice. Our pitch is about the moment after a repair. A student can line up their own actions with the service signals, explain why they acted, and replay the decision they would change. That makes OpsReplay a good fit for someone preparing for the interviewer’s follow-up. We still need to test whether students value that review enough to come back.

**Source note.** [SadServers](https://sadservers.com/) and [KodeKloud 100 Days of DevOps](https://kodekloud.com/100-days-of-devops). The comparison describes each provider’s published offering.

### Slide 13. What students told us | 9:10 to 10:00

We surveyed 25 students over one week. Roughly nine in ten said they would try OpsReplay, and students saw a use for it in interview preparation. That gives us a reason to start with interview practice groups. We’d offer one free incident and see who actually starts it. Then we’d track whether a classmate joins through a referral. Those two observations would tell us how much of the interest in our survey turns into use. The next numbers are a scenario for what that could look like.

**Source note.** Team-reported informal survey of 25 students over one week. About 90% is a rounded figure. The team supplied no respondent-level data or observed conversion rate.

## Speaker 5 | Growth, pricing and operating costs | 10:00 to 12:30

### Slide 14. A free first incident | 10:00 to 10:30

A student can try a full incident, review the debrief and replay their decisions for free. We’re using S$11.99 a month as the placeholder Pro price for more exercises and longer sessions. The first purchase would test whether another case is worth paying for. We haven’t collected payments. Here’s how the survey week might translate into a year of sign-ups if we kept reaching new students.

**Source note.** S$11.99 per month is the presentation pricing assumption. Existing product scope includes free playback, retry and a future institutional offer.

### Slide 15. How many learners could we reach? | 10:30 to 11:10

Suppose we reach 25 new students every week for 52 weeks. That’s 1,300 students. If the survey’s interest level holds, about 1,170 would express interest. We assume half actually try a lab, giving us 585 direct sign-ups. If every four direct users bring in one additional classmate, that adds about 146. Together, that’s roughly 731 distinct sign-ups over a year. We count only first-generation referrals and assume those classmates are new to the product.

**Source note.** Illustrative acquisition model. Direct sign-ups = 25 × 52 × 90% × 50% = 585. Referrals = 585 ÷ 4 ≈ 146. Total ≈ 731. Outreach pace, future interest, follow-through and referrals are assumptions.

### Slide 16. What those sign-ups could earn | 11:10 to 11:46

For the revenue scenario, suppose ten percent of all first-year sign-ups are still paying at year-end. That assumption includes both conversion and retention. It gives us about 73 paying subscribers. At S$11.99 a month, that’s S$875 of year-end monthly subscription revenue. If that monthly level held for twelve months, the annualized run rate would be about S$10,503. That’s a hypothetical year-end pace. Cash collected during year one depends on when subscribers join and how long they stay.

**Source note.** Projected year-end MRR = 73 × S$11.99 = S$875.27. Illustrative exit ARR = S$875.27 × 12 = S$10,503.24. The 10% active-paid share at year-end is an assumption, not a survey result.

### Slide 17. Would that cover our costs? | 11:46 to 12:30

Our budget allocates about S$972 a month to shared infrastructure, content, support and acquisition. At the new price, each paying subscriber contributes about S$9.18 after estimated variable delivery costs, free use and payment fees. The 73-subscriber scenario covers about S$670, leaving S$302 a month to cover. We’d need 106 paying subscribers, or 33 more than the projection, to meet that budget before engineering payroll. That’s why measuring paid retention and actual lab usage matters as much as finding the next cohort.

**Source note.** Recalculated from the October pricing proposal using the S$11.99 placeholder. Fixed allocation S$972.066855/month. Per paid subscriber: S$1.8208395 variable delivery and free subsidy, S$0.99159 assumed payment fees, S$9.1775705 contribution. Base usage includes six paid lab hours/month and five active free users per payer. Engineering payroll is excluded.

## Speaker 6 | Proof, pilot and closing hook | 12:30 to 15:00

### Slide 18. What we have tested | 12:30 to 13:20

In a temporary AWS deployment, a test user started a Challenge, repaired a service, reviewed the result, replayed the attempt and tried again. The team took that deployment down. The updated build needs fresh qualification before the learner pilot. We’ve seen the workflow run. What we still want to measure is whether someone can use that experience to explain a different failure.

**Source note.** OpsReplay README, 4 November 2026 status and cited AWS checkpoints.

### Slide 19. What the pilot would measure | 13:20 to 14:10

We plan to work with five to ten learners. Each gets an interactive incident and static material for a different case, with the assistant off. We’ll ask which dependency failed, which clue supports that explanation, and what they would check first on a new case. Since the incidents differ in difficulty, we’ll examine the answers by case and assignment.

**Source note.** OpsReplay formative pilot protocol and transfer rubric. This small study has no measured results yet.

### Slide 20. Checkout is down. What do you check first? | 14:10 to 15:00

Picture the interview. The storefront loads, but every order fails. The interviewer asks, “What do you check first?” With OpsReplay, you can answer from an incident you actually worked through. You can describe what you saw, which dependency you tested, and how you knew the customer could buy again. Now picture your first on-call shift. It’s the same question, and this time a customer is waiting. What would you check first?

**Source note.** Closing scenario for illustration.

[pitch-deck]: <OpsReplay Startup Pitch - Final.pptx>
