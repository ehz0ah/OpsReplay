# OpsReplay pricing proposal

Status: presentation proposal, not a validated price or a live subscription.
Prepared: 26 October 2026. Currency: SGD unless marked USD.

## Offer

Free gives a complete sample in each mode, including Challenge debrief and playback.
Pro is proposed at S$12/month for the expanded published library and longer Challenge
sessions. Free also supports fresh-environment retries and preserves first results.
The Pro content and time limits are server-owned differences, not cosmetic badges.
The demo has no payment, recurring charge or automatic renewal.
It activates only an operator-approved fixed-window grant.

Do not advertise a large library, unlimited compute, monthly usage meters or
institution management that the prototype does not provide. Institutional seats
remain a future sales model with no invented price.

S$12 is a testable price hypothesis. SadServers currently offers Pro at US$9/month
and Pro+ at US$11/month, with more than 125 scenarios. OpsReplay cannot claim content
parity. Its value hypothesis is integrated evidence, safe assistant proposals,
Code Review, causal debrief and synchronized playback. A launch needs more curated
content and willingness-to-pay tests. S$8 leaves materially less operating margin;
S$16 needs stronger evidence of content value. No annual lock-in is proposed yet.

## Delivery cost

Singapore list rates, before discounts and taxes:

| Resource                           |                                              USD rate |
| ---------------------------------- | ----------------------------------------------------: |
| Linux x86 Fargate CPU              |                                 0.05056 per vCPU-hour |
| Fargate memory                     |                                   0.00553 per GB-hour |
| Interface endpoint                 |                                     0.013 per AZ-hour |
| Internal application load balancer |                                       0.0252 per hour |
| ALB LCU                            |                                    0.008 per LCU-hour |
| Public IPv4                        | 0.005 per address-hour, only where actually allocated |

The code allocates 1 vCPU and 2 GiB to each Challenge: US$0.06162 per billable
hour. Billing includes provisioning and cleanup, not just learner-ready time.

One gateway (0.5 vCPU, 1 GiB), three interface endpoints in two AZs and one internal
ALB cost about US$97.83/month at 730 hours. This excludes LCU usage, WAF, logs,
storage, requests and extra gateway capacity. It is a lower-bound rate projection,
not AWS measured spend. Idle shared infrastructure is the main small-scale cost.

## Base case assumptions

Use a planning FX rate of S$1.35/US$1, not a claimed current quote.

| Assumption                                      | Monthly value |
| ----------------------------------------------- | ------------: |
| Paid Challenge billable hours per subscriber    |             6 |
| Paid assistant cost per subscriber              |       US$0.30 |
| Paid storage/API allowance per subscriber       |       US$0.15 |
| Active Free users per paid subscriber           |             5 |
| Free billable hours per active Free user        |           0.5 |
| Free assistant cost per active Free user        |       US$0.05 |
| Free storage/API allowance per active Free user |      US$0.025 |
| Shared infrastructure projection                |      S$132.07 |
| Additional shared requests/WAF/log allowance    |          S$40 |
| Content/support allocation, 20 hours at S$30    |         S$600 |
| Acquisition allocation                          |         S$200 |

Usage, assistant costs, conversion and staffing are assumptions. They are not user
study findings or provider quotes. The live evaluation must measure token counts,
task lifetimes and request/storage volumes before refining them.

Future payment model: Singapore domestic card processing at 3.4% + S$0.50, plus
0.7% Billing if Stripe Billing is used. At S$12 this is S$0.992. The demo pays no
processing fee because it processes no payments. International cards, FX, refunds,
disputes and optional tax products can add cost.

## Model

```
challengeRateUSD = 0.05056 + 2 * 0.00553 = 0.06162
freeUserCostSGD = (0.5 * challengeRateUSD + 0.05 + 0.025) * 1.35
paidVariableSGD = (6 * challengeRateUSD + 0.30 + 0.15) * 1.35
                  + 5 * freeUserCostSGD
                 = 1.8208395
paymentFeeSGD = price * (0.034 + 0.007) + 0.50
contributionSGD = price - paidVariableSGD - paymentFeeSGD
monthlyFixedSGD = 132.066855 + 40 + 600 + 200 = 972.066855
operatingResultSGD = paidSubscribers * contributionSGD - monthlyFixedSGD
```

At S$12, contribution is S$9.19 per subscriber after delivery, Free subsidy and
future payment fees. Infrastructure-only break-even is 19 paid subscribers.
The stated operating allocation breaks even at 106, not 19. At 100 subscribers,
the projected result is -S$53.35/month. At 200, it is +S$865.37/month, before
engineering payroll, startup recovery, corporate tax and other unbudgeted costs.
This is not a profitability claim.

## Sensitivity

All other base assumptions remain constant.

| Case                               | Contribution per paid user | Operating break-even |
| ---------------------------------- | -------------------------: | -------------------: |
| S$12, base                         |                     S$9.19 |                  106 |
| 60 billable hours per paid user    |                     S$4.70 |                  208 |
| 20 active Free users per paid user |                     S$7.04 |                  138 |
| US$3 assistant spend per paid user |                     S$5.54 |                  176 |
| S$8 price                          |                     S$5.35 |                  182 |
| S$16 price                         |                    S$13.02 |                   75 |

A 24/7 Challenge user can exceed the subscription revenue. One active attempt per
learner and finite session durations do not bound total monthly compute. Do not sell
unlimited Challenge runtime without usage evidence, abuse controls and a funded
heavy-user policy. Those commercial controls are not implemented by a demo grant.

The global environment guard is a system safety limit, not a Pro feature. A launch
must fund enough capacity and give temporary capacity failures clear recovery
guidance. A small demo cap cannot be presented as a production service guarantee.

If GST must be remitted and the displayed S$12 includes 9% GST, revenue before
fees/costs becomes S$11.01. Recompute break-even. Also test FX at 1.25 and 1.45,
extra gateway replicas, higher logging, acquisition cost and realistic paid labour.
No tax-registration status is assumed.

## Evidence required before charging

1. Measure warm/cold provisioning, learner duration and final cleanup lifetime.
2. Measure assistant tokens with the selected provider's current rates.
3. Validate shared cost at realistic concurrency and retention.
4. Interview learners about S$8, S$12 and S$16 and the current content value.
5. Run a real conversion/retention study only after payment and support are ready.

## Sources

- https://sadservers.com/pricing
- https://stripe.com/en-sg/pricing
- https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/current-gst-rates
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/ap-southeast-1/index.json
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/ap-southeast-1/index.json
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/ap-southeast-1/index.json

Sources checked through official public pages. FX and allowances are planning
assumptions. The AWS Pricing API is blocked by the school SCP; public offer files
were used without bypassing that control.
