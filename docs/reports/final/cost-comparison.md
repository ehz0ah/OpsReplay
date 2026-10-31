# Cloud and on-premise comparison working model

Status: sourced inputs and sensitivity model, 31 October 2026. This is not a
measured comparison of equivalent deployments. Final campaign charges and a
qualified on-premise configuration remain required.

## Equivalent service boundary

The current code directly uses AWS SDKs for state, object storage, identity,
task launch and schedules. Running the three images on a server does not replace
the complete SaaS. A full on-premise alternative must preserve these operations:

| AWS component                                    | Required on-premise function                              | Behaviour that must remain equivalent                                                        |
| ------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CloudFront, S3 static hosting and API Gateway    | HTTPS ingress, static hosting and separate action workers | Exact origins, authentication, request limits and streamed replies                           |
| Cognito                                          | Identity service and email delivery                       | Verified-email registration, token validation, expiry and owner identity                     |
| DynamoDB                                         | Durable transactional state store                         | Conditional writes, immutable request receipts, owner indexes and stale-worker rejection     |
| S3 recording and bootstrap storage               | Private object store and backup                           | Checksums, immutable page references, restricted bootstrap access, expiry and deletion       |
| Fargate environment tasks                        | Isolated container/VM scheduler                           | Dedicated attempts, pinned images, resource limits, private networking and confirmed cleanup |
| Scheduler and lifecycle events                   | Durable timers, job discovery and retry workers           | Saved deadlines, repeat-safe reconciliation and recovery after worker/host restart           |
| CloudWatch, alarms and infrastructure deployment | Logs, metrics, alerts, secrets and deployment controls    | Private data exclusion, bounded retention, rollback and operator visibility                  |

These are requirements for the comparison, not an instruction to add another
deployment platform to the MVP. DynamoDB Local is a development test tool; its
passing tests do not establish a production replacement. A database or storage
adapter needs its own atomicity, lease, recording and recovery verification.
The same external LLM, authored content and learner workload apply to both hosts.

## Public source inputs

Sources were read through ordinary public-page search/fetch on 31 October 2026.
No purchase, account change or local infrastructure test was performed.

| Input                      | Observed source                                                                                                                                                                                                                               | Use and limit                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electricity                | [SP Group tariff](https://www.spgroup.com.sg/our-services/utilities/tariff-information): 28.59 cents/kWh before GST, 1 October to 31 December 2026                                                                                            | Use S$0.2859/kWh for a regulated-tariff sensitivity case. The selected premises' actual contract and tax treatment still need confirmation                                                                 |
| Entry server specification | [Dell T160 manual](https://www.dell.com/support/manuals/en-us/poweredge-t160/t160_ism_pub/dell-poweredge-t160-system-overview?guid=guid-82466e07-18e7-4550-bc64-ff0638ab15af&lang=en-us): single socket, four ECC UDIMM slots, one cabled PSU | Identifies a plausible small-server class; maximum specifications do not describe the priced configuration or prove capacity                                                                               |
| Retail configuration       | [Sim Lim Square / Bizgram T350 listing](https://www.simlimsquare.com.sg/product/dell-poweredge-t350-poweredge-t350-xeon-e-2324-1x8gb-dim-9850): S$4,955.80 displayed for Xeon E-2324, 8 GB RAM, 2 TB SATA HDD, single non-redundant PSU       | A dated advertised configuration, not a qualified quote. RAM/storage upgrades, tax, delivery, current stock and warranty must be confirmed. Do not substitute this unmodified machine for the full service |
| AWS regional rates         | [Pricing proposal](../../decisions/pricing-proposal.md)                                                                                                                                                                                       | Dated list-rate projection; final use and billed charges remain separate                                                                                                                                   |

Dell's direct T160 product page was blocked during fetch. Its search-result
starting price was not used as a qualified quote. The PSU watt rating is maximum
capacity, not measured power draw. No retailer payment details or copied product
assets belong in this report.

## Defined workload and capacity limit

Let `H` be total Challenge image-pull-start-to-stop hours per month, across all
paid and Free learners. Include provisioning and drain. A retained Gateway and
platform services operate for 730 hours/month. Candidate planning cases use
`H = 50, 400, 1200`, with at most two simultaneous attempts. These are workload
assumptions, not measured demand or production limits.

Two simultaneous attempts require a host allocation for both Challenge/Monitor
pairs plus Gateway, API, state, storage, identity and the OS. CPU labels, core
counts and RAM alone cannot prove terminal responsiveness or recording correctness.
A 1,460-hour monthly ceiling follows from two tasks times 730 hours, but does not
prove that any quoted host can deliver that workload. Bursts can exceed a host's
capacity even when total monthly hours are low. A larger class requires resized
hardware and a new comparison; do not extend the two-attempt price line to it.

## Transparent sensitivity assumptions

All amounts below are SGD before GST. Use the same S$1.35/US$1 planning FX rate
as the pricing proposal. The hardware figures are sensitivity inputs, not vendor
quotes. Electricity is sourced; all other inputs in this table are assumptions.

| Input                           |                                Working value | Sensitivity to report                                                                 |
| ------------------------------- | -------------------------------------------: | ------------------------------------------------------------------------------------- |
| Cloud shared infrastructure     |                           S$132.066855/month | More Gateways/AZs and actual hourly availability                                      |
| Cloud other service use         |                                   S$40/month | Replace with API, identity, WAF, storage, log and transfer measurements               |
| Challenge compute               |                              S$0.083187/hour | Exact allocation, provisioning/drain duration and FX                                  |
| Hardware capex                  |                                      S$4,000 | S$1,000 and S$8,000; qualified bill of materials still absent                         |
| Hardware useful life            |                                    36 months | 24 and 60 months; no residual value assumed                                           |
| Average host draw               |                                        100 W | 50 and 200 W; must be measured under idle and active load                             |
| Power/cooling overhead          |                               1.4 multiplier | Premises-dependent; must include other dedicated equipment                            |
| Network allocation              |                                   S$50/month | Existing institutional connection versus a dedicated contract                         |
| Backup/storage allocation       |                                   S$30/month | Recording growth, retention, redundancy and restore tests                             |
| Maintenance allocation          |                                   S$20/month | Repairs, spare parts and software/licence/support needs                               |
| Cloud operations                |                   2 hours/month at S$30/hour | Actual operator time                                                                  |
| On-premise operations           |                   6 hours/month at S$30/hour | Also show equal 2-hour labour; managed services do not remove all cloud operations    |
| Initial on-premise adapter work | 60 hours at S$30/hour, spread over 36 months | 0 hours for an already qualified deployment; larger effort if adapters need more work |

The port allowance is comparison work, not measured implementation effort or
permission to build the alternative. It covers adapting the current AWS-specific
control/data paths. Content development, ordinary application development,
acquisition and external provider cost are equal terms outside this hosting table.
Add them back when calculating the whole business result.

```text
cloudMonthly = 132.066855 + 0.083187 * H + 40 + 2 * 30

powerMonthly = (100 / 1000) * 730 * 0.2859 * 1.4
             = 29.21898

onPremiseMonthly = 4000 / 36 + powerMonthly + 50 + 30 + 20
                  + 6 * 30 + (60 * 30) / 36
                 = 470.330091...
```

| Total Challenge hours/month | Cloud projection | On-premise working case |
| --------------------------: | ---------------: | ----------------------: |
|                          50 |         S$236.23 |                S$470.33 |
|                         400 |         S$265.34 |                S$470.33 |
|                        1200 |         S$331.89 |                S$470.33 |

The apparent advantage comes partly from assigned labour and adapter effort,
which are not measurements. At the same two hours of operations, on-premise falls
to S$350.33. With that labour and no new adapter work, it falls to S$300.33 and is
below the cloud projection at 1,200 hours. Therefore the table does not prove that
cloud is cheaper. An existing qualified host or dedicated IT team changes the
decision materially.

The base case's algebraic crossing is about 2,864 Challenge-hours/month, outside
the candidate 1,460-hour ceiling. It is not an achievable break-even point for
this candidate. The equal-labour, no-port case crosses at about 821 hours, within
the arithmetic ceiling but still subject to measured peak capacity. Do not draw a
continuous cost curve beyond the host's verified capacity.

## Availability and final evidence

A single non-redundant host cannot claim availability equivalent to managed
multi-zone state and object storage. Report this difference, or price and test
redundant hosts, power/network and replicated data at the same target. Backup is
not continuous failover. Cloud credits and sunk institutional hardware must be
reported separately from total economic cost.

To complete the comparison, obtain a qualified host quote and measure the same
reference workloads, recording volume/retention, peak concurrency, power and
operator effort. Verify identity, transaction semantics, cleanup and backup/restore
for the comparison boundary. Match AWS charges to run-owned resources and list
shared allocations. State missing evidence; do not convert this working model
into an observed hosting-cost winner.
