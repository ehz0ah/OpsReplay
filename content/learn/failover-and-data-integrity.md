---
{
  'id': 'failover-and-data-integrity',
  'version': '0.1.0',
  'title': 'Failover must preserve data integrity',
  'category': 'database',
  'plan': 'pro',
  'summary': 'Study why restoring network connectivity may not restore a database-backed service.',
  'lessons':
    [
      'Network recovery does not imply data replicas are consistent.',
      'Failover topology must fit application latency assumptions.',
      'Backlog processing can extend the recovery period.',
    ],
  'sources':
    [
      {
        'title': 'GitHub: October 21 post-incident analysis',
        'url': 'https://github.blog/news-insights/company-news/oct21-post-incident-analysis/',
      },
    ],
  'relatedExercises': [],
}
---

## A short interruption with a long consequence

GitHub reports that a network interruption in October 2018 triggered database failover to another location. Connectivity returned, but the database sites had accepted writes that were not present in the other site.

Moving the primary back immediately would not safely reconcile those writes. Applications also experienced increased latency when reaching the new primaries.

## Separate recovery conditions

Check connectivity, replication, application behavior, and queued work independently. A passing network check answers one question. It does not prove that data is consistent or that all user operations have recovered.

GitHub prioritised data integrity during recovery and paused some background work. Restoring database topology did not immediately clear delayed replicas and queued work.

## Use evidence to choose the next action

Identify which replica has accepted each write before selecting a primary. Compare the topology with the application's latency budget. Check backlog growth before enabling all workers at once.

## Reflection

Describe what has recovered and what remains affected. A single green indicator cannot represent every layer. Preserve raw evidence when explaining why an apparently simple rollback is unsafe.
