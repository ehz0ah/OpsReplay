# Final report draft

Status: working draft, 1 November 2026. This is not a submission-ready report.

[Final.tex](Final.tex) describes the implemented product at merged revision
`5c33055c59846c784f978ababd2075fe2b3dad90`. The
[1 November checkpoint](../../checkpoints/2026-11-01-release-qualification.md)
records fresh image qualification, hosted recovery and paid assistant measurements.
The 29 October sign-up and GET measurements retain their separate source/workload.
PR #137 is a narrow assistant instruction fix; its targeted calls are not a
post-fix accuracy benchmark.

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

The presentation source is [Slides.tex](Slides.tex), with
[speaker notes](speaker-notes.md) and the [demo plan](demo.md). Build it with:

```sh
tectonic --only-cached --untrusted --keep-logs --outdir build Slides.tex
```

The slide build currently uses locally installed Arial and Menlo fonts. They
are embedded in the generated PDF but are not copied into the repository. The
TeX source requires those fonts in another build environment, or an explicitly
reviewed substitute with a fresh layout check. Tectonic reports this portability
limit. No font or package installation is part of the build command.

The deck has fifteen main slides and three Q&A backups. Its six speaking blocks
sum to a planned fifteen minutes, including a four-minute Challenge segment.
This is not measured rehearsal time. Assign all six speakers and rehearse with
the actual deployment and a redacted fallback recording before submission.

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
2. Review the completed deadline, deletion and cleanup evidence. Merge focused
   assistant/lifecycle fixes separately; their CI is not a new deployed checkpoint.
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
7. Build, inspect and export the completed report as `Final.pdf`. Prepare
   `Slides.pdf` and the [demo sequence](demo.md), with every member presenting.

No new service, live payment system, institutional dashboard or scenario
generation feature is implied by this report work.
