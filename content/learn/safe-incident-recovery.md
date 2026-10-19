---
{
  'id': 'safe-incident-recovery',
  'version': '0.1.0',
  'title': 'Safe recovery starts with evidence',
  'category': 'operations',
  'plan': 'free',
  'summary': 'Use a previous incident to practise checking assumptions before a recovery action.',
  'lessons':
    [
      'Recovery automation needs explicit empty-input behavior and safe retries.',
      'Impact can appear as latency even when a service remains reachable.',
      'Record the causal chain and test follow-up actions.',
    ],
  'sources': [{ 'title': 'Google SRE: Postmortem Culture', 'url': 'https://sre.google/workbook/postmortem-culture/' }],
  'relatedExercises': [{ 'mode': 'challenge', 'id': 'wrong-upstream-port', 'title': 'Wrong upstream port' }],
}
---

## What happened

Google describes a maintenance incident in which retrying a completed rack-decommission step produced an empty machine list. The API interpreted that list as no filter. The retry therefore selected machines beyond the intended rack.

The affected proxy machines stopped serving traffic. Requests moved to central data centres, increasing latency. The source describes capacity planning as a reason the user impact stayed limited.

## Investigate the boundary

Ask what each input means before rerunning automation. Does an empty list mean do nothing or select everything? Check the target set, the previous run's effects, and whether the next run can repeat them safely.

An operation that succeeds once is not necessarily safe to retry. A lost response can hide a completed effect.

## Apply the lesson

In the related proxy Challenge, inspect the failing request and configuration before changing a service. Validate the configuration before applying it. Compare the failure rate after the change with the initial state.

This exercise is synthetic. It practices the investigation principle; it does not reproduce Google's infrastructure.

## Reflect

Explain the trigger, the system behavior, and the recovery separately. A reachable service can still deliver a poor user experience. Use measured request failures and latency to describe impact.
