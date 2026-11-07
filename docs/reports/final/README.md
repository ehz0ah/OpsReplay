# Final report draft

Status: working draft, 4 November 2026. This is not a submission-ready report.

[Final.tex](Final.tex) describes the implemented product at merged revision
`71cf2d3b95efcadb728c8a69ae579b5d585fc301`. The
[1 November checkpoint](../../checkpoints/2026-11-01-release-qualification.md)
records fresh image qualification, hosted recovery and paid assistant measurements.
The 29 October sign-up and GET measurements retain their separate source/workload.
PR #137 is a narrow assistant instruction fix; its targeted calls are not a
post-fix accuracy benchmark. The [4 November image gate](../../checkpoints/2026-11-04-image-gate.md)
blocked activation on new SQLite HIGH findings. No fresh gameplay/browser or
provider test ran. Early cleanup and durable preservation were verified.
PR #141's SQLite fix is merged; fresh merged-source ECR qualification is pending.

The adopted preliminary report is version 5. The older `Preliminary.tex` contains
an earlier simulated-engine design and must not be used as the final architecture.
The current implementation uses isolated real services, recording playback and
fresh-task retries.

## Build and review

From this directory, with an existing Tectonic installation and cached packages:

```sh
mkdir -p build
tectonic --only-cached --untrusted --keep-logs --outdir build Final.tex
```

This command does not install tools or fetch TeX packages. If required packages
are absent, keep the source draft and use the team's existing TeX environment.
The generated PDF and logs belong in the ignored `build` directory.

The [startup pitch deck][pitch-deck] has twelve slides.
The [Markdown speaker script](speaker-notes.md) gives each of six speakers two
slides and 2 minutes 30 seconds. Slides 5 and 6 reserve space for real app
screenshots. Rehearse the walkthrough against the captures used on those slides.

The course limit is ten pages for the complete `Final.pdf`, including references
and cover material. Check the actual PDF page count, tables, diagram labels,
links and text extraction after each material edit. Keep the draft footer until
all required evidence and team statements are complete. Do not remove missing
results to make the report appear complete.

## Evidence map

| Report claim                                                                       | Source                                                                                | Limit                                                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Product, Free/Pro access and real Challenge workflow                               | [PRD](../../PRD.md), [decision register](../../decisions/README.md), current code     | Intended learning benefit requires participant evidence                                  |
| 29 October sign-up, ownership, response-loss recovery, both Challenges and cleanup | [AWS checkpoint](../../checkpoints/2026-10-29-saas-aws.md)                            | Two serial attempts, one Gateway; paid provider off                                      |
| 450 successful GETs and endpoint p50/p95                                           | Same AWS checkpoint                                                                   | One and two workers; no provisioning or terminal capacity result                         |
| Twenty repeats of two suites per Challenge                                         | Private aggregate reports at revision `f89e258`                                       | Historical local Docker evidence, not current-image Fargate performance                  |
| Neobrutalist frontend behaviour and responsive checks                              | [Frontend decision](../../decisions/neobrutalist-discovery.md), 1 November checkpoint | Fixture widths plus hosted History/debrief/playback; native mobile untested              |
| Assistant timing and cost-accounting corrections                                   | [Evaluation runbook](../../runbooks/evaluation-tools.md), merged PR #128              | Fake-provider verification, not a model benchmark or provider cap                        |
| Proposed price, delivery assumptions and break-even                                | [Pricing proposal](../../decisions/pricing-proposal.md)                               | Price and demand unvalidated; rate projection is not an invoice                          |
| Pilot procedure and counterbalancing limits                                        | [Pilot package](../../evaluation/pilot/README.md)                                     | No participant outcome supplied for this draft                                           |
| Exact-image qualification and current hosted recovery                              | [1 November checkpoint](../../checkpoints/2026-11-01-release-qualification.md)        | Scoped glibc acceptance; residual lower findings and larger capacity remain open         |
| New exact-source image gate and early cleanup                                      | [4 November checkpoint](../../checkpoints/2026-11-04-image-gate.md)                   | PR #141 merged; fresh merged-source ECR qualification pending                            |
| Paid assistant baseline and deployed streams                                       | Same checkpoint; private rubric, receipts and CloudWatch usage                        | Small sample; agent manual grades; original failure retained; no security-fixture result |

Private aggregate evidence was inspected for the draft. Raw recordings, account
identifiers, provider responses and credentials must remain outside Git. The
report cites public checkpoint summaries and labels the private aggregates' scope.

The [on-premise working comparison](cost-comparison.md) defines the equivalent
service boundary, a sourced electricity tariff and hardware-listing limits, and
cost sensitivity. Its numerical cases are assumptions, not measured equivalent
deployments or proof of the cheaper hosting option.

## Required completion work

1. Keep tested source, image digests, review fixes and later deployments distinct.
   Do not describe two targeted prompt calls as a complete post-fix benchmark.
2. Qualify fresh merged-source images after the merged SQLite fix in PR #141.
   Existing CI and historical runtime evidence do not open the new gate. The
   three new GCC MEDIUM findings remain open outside that fix.
3. Preserve assistant denominators, missing text deltas, failure reservations and
   dated usage estimates. Provider-console cap verification is not a prerequisite
   under the owner's instruction; no enforced billing cap is claimed.
4. Run the participant study after its readiness and data-deletion conditions pass.
   Replace the missing-result paragraph with anonymous results and limitations.
5. Match final AWS charges to the test resources. Obtain a dated equivalent-host
   quote, capacity evidence, power and operating assumptions. Complete the
   cloud/on-premise comparison without asserting that cloud is always cheaper.
6. The team must verify the AI-use scope, add its own learning statement and
   confirm the final author list. Do not invent these statements.
7. Build, inspect and export the completed report as `Final.pdf`. Rehearse
   the [pitch script](speaker-notes.md) with all six speakers.

No new service, live payment system, institutional dashboard or scenario
generation feature is implied by this report work.

[pitch-deck]: <OpsReplay Startup Pitch.pptx>
