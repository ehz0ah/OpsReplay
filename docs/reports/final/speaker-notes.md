# OpsReplay startup pitch script

Companion to the [PowerPoint deck][pitch-deck]. Six speakers have two slides and 2 minutes 30 seconds each. Use the timestamps as rehearsal targets. Italicized cues are for the presenter.

## Speaker 1 | The hook and the problem | 0:00 to 2:30

### Slide 1. AI-generated code at Google | 0:00 to 1:15

Before you look at the number, think about the last time a coding agent drafted a change for you. How much of your time went into writing the code, and how much went into deciding whether to trust it? In April, Google reported that AI generated three quarters of its new code and engineers approved it. That is one company’s experience. It gives us a picture of what engineering work can look like when generating a change is cheap.

Now imagine that change has shipped and customers suddenly cannot check out. An agent can suggest a fix in seconds. Who decides whether to try it? Who checks whether customers can buy again? OpsReplay is a place for the engineer who has to make those calls to practise before their first real outage.

**Source note.** Google Cloud Next, April 2026. https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/cloud-next-2026-sundar-pichai/

### Slide 2. When an agent has to find the fault | 1:15 to 2:30

Picture a checkout page that loads normally. A customer presses Buy, waits, and gets an error. Several teams own the services behind that button. A restart sounds reasonable, but which service would you restart, and what evidence would change your mind? This is where an agent still faces a hard problem.

In May, IBM and Artificial Analysis gave agents snapshots of 59 reliability incidents and asked them to identify the root causes. The strongest model they tested scored 47% on their diagnosis metric. That figure measures performance on those tasks, not the share of real outages an agent can fix. For a junior engineer, the immediate problem is learning how to act with incomplete evidence. Our second speaker will introduce the people who need that practice.

**Source note.** IBM Research and Artificial Analysis, ITBench-AA launch, May 2026. https://huggingface.co/blog/ibm-research/itbench-aa

## Speaker 2 | The customer and the product | 2:30 to 5:00

### Slide 3. Who needs incident practice? | 2:30 to 3:45

Our first learner is a computing student who has built and deployed an application but has never had to restore one under pressure. The same need follows a junior engineer onto their first on-call rotation. Both can study a published incident report. By the time they read it, the author already knows which clue mattered.

We want to let the learner experience the earlier moment, when two explanations are still plausible and the next decision has a cost. An instructor gives us a way to reach that learner at the point of need. They can place an incident after a systems or cloud module, then ask students to defend the action they chose. That gives us a specific user, a potential sponsor and a concrete first use for the product.

**Source note.** OpsReplay PRD, Audience and Problem and intended outcome.

### Slide 4. Inside an OpsReplay Challenge | 3:45 to 5:00

A Challenge starts with a customer-visible symptom. The learner enters a private lab with a real failing service, looks at the available evidence, and decides what to change. Because the service is real, a mistaken action can make the outage worse inside the exercise. A successful repair has to pass a customer-facing check.

Afterwards the learner can replay what they tried and repeat the incident in a fresh environment. We also have short incident readings and code review exercises for learners who want context before they enter the lab. The Challenge is the part around which we would build the business. It gives a learner an incident to own and an instructor a concrete decision to discuss afterwards. Let’s walk through one checkout incident.

**Source note.** OpsReplay README, product scope and Challenge workflow.

## Speaker 3 | The checkout walkthrough | 5:00 to 7:30

### Slide 5. Why did checkout fail? | 5:00 to 6:15

*Screenshot cue. Replace the marked frame with a learner-facing Challenge workspace capture showing the incident symptom, terminal and visible service signals. Use a redacted capture from an actual run.*

*Read the symptom on screen. Ask what the audience would check first, then pause.*

The customer wanted to place an order. All the learner knows at the start is that checkout is failing. They can look at what the service returned and when requests started failing, or they can go straight to a repair. *Point to the terminal and the signals beside it.* Does the failure affect the whole site or just the part that accepts an order? I would check which requests succeed before changing anything.

If the learner wants help, the optional assistant can suggest a command. The learner chooses whether it runs. The first decision stays theirs. Now follow that decision through to the result.

### Slide 6. Did the fix work? | 6:15 to 7:30

*Screenshot cue. Replace the frame with an actual debrief or playback capture. Choose one with a readable outcome or time-aligned investigation evidence. Use the observed result in the talk.*

A green status alone would make a poor lesson. *Point to the observed outcome.* Could a customer complete checkout again? *Point to one recorded action and the failed requests around it.* The two events appearing together is a reason to investigate, not proof that one caused the other. Which clue would you check earlier on a second attempt?

A fresh retry lets the learner try that idea while keeping the first result intact. This is the part an instructor can use for discussion: a learner can explain what they believed at the time and how later evidence changed that belief. Our next speaker will show how that experience fits among the ways people already learn.

## Speaker 4 | Alternatives and the route to market | 7:30 to 10:00

### Slide 7. How engineers practise today | 7:30 to 8:45

Engineering students already have good options. A written postmortem can explain a complex failure in the words of the team that experienced it. A service such as SadServers gives people hands-on troubleshooting on live Linux and DevOps systems. We have to give someone who already uses those resources a reason to come back.

Our bet is that seeing their own investigation again matters. A student who found the fix by guessing can revisit the earlier signals and see what was available before the guess. A student who missed the fix still has something specific to discuss. We will ask instructors whether that replay changes the quality of the explanation students bring to class. That is the difference we want learners to value enough to return.

**Source note.** SadServers, hands-on troubleshooting labs. https://sadservers.com/ ; OpsReplay PRD, P09 and P10.

### Slide 8. Our first route to learners | 8:45 to 10:00

Here is how we would reach the first group without assuming a large sales team. Start with an instructor who already teaches cloud or systems troubleshooting. Agree on one course objective and one relevant incident. The instructor can introduce the free Challenge after that lesson. At the end, invite learners to explain a decision using their replay.

Watch whether they come back for another exercise, then ask what they would want in a paid library. That gives us a way to distinguish course participation from voluntary demand. If learners return and an instructor wants to repeat the exercise with a class, we can explore seats for the next cohort. This is a proposed route to market. Our fifth speaker will explain what we would charge and what has to be true for the economics to work.

**Source note.** Proposed go-to-market plan for the pitch. OpsReplay PRD, Audience and P01.

## Speaker 5 | Pricing and economics | 10:00 to 12:30

### Slide 9. A free first incident | 10:00 to 11:15

The free plan needs to deliver a complete experience. A learner can try an introductory incident, see the full debrief, replay the session and retry. Our proposed Pro price is twelve Singapore dollars a month for access to more published exercises and longer Challenge sessions. The reason to upgrade would be another incident worth practising. A wider library matters more than a paywall in front of the first result.

The third route is a future per-seat offer for a class or training cohort. We would test that with instructors separately from an individual subscription. Today the prototype can demonstrate access levels. It does not take payment, and willingness to pay is still an open question. In an interview, we would ask which exercise would justify a second month.

**Source note.** OpsReplay pricing proposal dated 26 October 2026, Offer and Evidence required before charging.

### Slide 10. What would 106 subscribers cover? | 11:15 to 12:30

At the proposed price, our base case leaves about nine dollars and nineteen cents per paid subscriber per month after variable delivery costs, support for free usage and assumed payment fees. The model allocates about nine hundred and seventy-two dollars a month to shared costs, content, support and acquisition. Covering that allocation takes about 106 paying subscribers. Engineering payroll is outside that figure.

The assumption to pay attention to is usage. If each paid learner runs sixty billable hours a month instead of six, the same threshold rises to 208. Those numbers tell us what to measure during a pilot: time spent running exercises, how much practice learners come back for, and whether they value another month at the proposed price. Our final speaker will close with what we have actually tested and who we need next.

**Source note.** OpsReplay pricing proposal, Model and Sensitivity. All figures are planning estimates in SGD. Base case assumes five active free users per subscriber and S$972.07 in monthly fixed allocations.

## Speaker 6 | Evidence and the pilot ask | 12:30 to 15:00

### Slide 11. What we have tested | 12:30 to 13:45

We have tested the learner path in a temporary AWS deployment. The team started a Challenge, repaired a real service, reviewed the result and playback, and retried in a fresh session. Those checks established that the workflow could run. The team took the deployment down, and the updated build still needs fresh qualification before learners can use it.

The next question is about people. Can someone use the replay to explain why a service failed and choose a safer recovery on another case? We have prepared a small study comparing interactive practice with static material, with the assistant off for the core exercise. We will look at the reasoning learners give and where the interface gets in their way. We have not yet measured a learning effect or customer demand.

**Source note.** OpsReplay README, 4 November 2026 project status. Evaluation study protocol in docs/evaluation/pilot/README.md.

### Slide 12. One instructor. One pilot class. | 13:45 to 15:00

We’re asking for one instructor who teaches systems or cloud engineering and can help us plan a pilot with five to ten learners. The first conversation is simple. Choose a familiar incident, tell us what a good student explanation would sound like, and identify a point in the course when the exercise would fit.

Once the build is qualified and participant safeguards are in place, we can run the study and share what students found confusing, which signals they used and whether they would choose another exercise. If you teach that course, or know the person who does, we would like an introduction after this session. Coding agents can already write much of the code. We want the people responsible for that code to have practised what happens when it fails.

**Source note.** OpsReplay formative pilot protocol, planned sample of 5 to 10. The instructor partnership is the proposed ask.

[pitch-deck]: <OpsReplay Startup Pitch.pptx>
