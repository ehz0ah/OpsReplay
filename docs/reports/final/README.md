# Final report draft

Status: working draft, 31 October 2026. This is not a submission-ready report.

[Final.tex](Final.tex) describes the implemented product at merged revision
`4df4842cf79a8f662b309bb778a9dc5765d29c6a`. It uses the 29 October AWS
checkpoint and the later frontend and benchmark-tooling records. The editor
backport in PR #129 is merged. Its final-head CI passed; fresh exact-digest
registry qualification remains pending.

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

The course limit is ten pages for the complete `Final.pdf`, including references
and cover material. Check the actual PDF page count, tables, diagram labels,
links and text extraction after each material edit. Keep the draft footer until
all required evidence and team statements are complete. Do not remove missing
results to make the report appear complete.

## Evidence map

| Report claim                                                                       | Source                                                                            | Limit                                                                   |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Product, Free/Pro access and real Challenge workflow                               | [PRD](../../PRD.md), [decision register](../../decisions/README.md), current code | Intended learning benefit requires participant evidence                 |
| 29 October sign-up, ownership, response-loss recovery, both Challenges and cleanup | [AWS checkpoint](../../checkpoints/2026-10-29-saas-aws.md)                        | Two serial attempts, one Gateway; paid provider off                     |
| 450 successful GETs and endpoint p50/p95                                           | Same AWS checkpoint                                                               | One and two workers; no provisioning or terminal capacity result        |
| Twenty repeats of two suites per Challenge                                         | Private aggregate reports at revision `f89e258`                                   | Historical local Docker evidence, not current-image Fargate performance |
| Neobrutalist frontend behaviour and responsive checks                              | [Frontend decision](../../decisions/neobrutalist-discovery.md)                    | Public fixtures; later hosted acceptance pending                        |
| Assistant timing and cost-accounting corrections                                   | [Evaluation runbook](../../runbooks/evaluation-tools.md), merged PR #128          | Fake-provider verification, not a model benchmark or provider cap       |
| Proposed price, delivery assumptions and break-even                                | [Pricing proposal](../../decisions/pricing-proposal.md)                           | Price and demand unvalidated; rate projection is not an invoice         |
| Pilot procedure and counterbalancing limits                                        | [Pilot package](../../evaluation/pilot/README.md)                                 | No participant outcome supplied for this draft                          |
| Package remediation candidate                                                      | PR #129                                                                           | Final-head CI passed; merged; exact-digest registry review pending      |

Private aggregate evidence was inspected for the draft. Raw recordings, account
identifiers, provider responses and credentials must remain outside Git. The
report cites public checkpoint summaries and labels the private aggregates' scope.

The [on-premise working comparison](cost-comparison.md) defines the equivalent
service boundary, a sourced electricity tariff and hardware-listing limits, and
cost sensitivity. Its numerical cases are assumptions, not measured equivalent
deployments or proof of the cheaper hosting option.

## Required completion work

1. Update the source revision after relevant PRs merge. Record new exact image
   digests privately and report their qualification status accurately.
2. Complete the grouped hosted failure-path checks and resource cleanup. Update
   the results table with pass/fail counts and the tested revision.
3. Verify the isolated provider cap and complete the reviewed assistant benchmark.
   Add denominators, full-loop latency, token usage and actual cost basis.
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
