# Challenge content

Each directory holds one source Challenge manifest. Wrong upstream port and
Stale DNS record have implemented images and integration tests. Their version
`0.1.2` releases have retained published metadata, checked on 26 October 2026.
No ECS runtime is currently deployed.

The source manifests remain synthetic draft build inputs with no image digests.
Publication creates separate immutable releases with checked digests and task
pins. A source draft is not the operational published release. Connection
exhaustion remains unimplemented and unpublished.

| Challenge                                                     | Tier   | Plan |
| ------------------------------------------------------------- | ------ | ---- |
| [Wrong upstream port](wrong-upstream-port/challenge.json)     | Easy   | Free |
| [Stale DNS record](stale-dns-record/challenge.json)           | Medium | Pro  |
| [Connection exhaustion](connection-exhaustion/challenge.json) | Hard   | Pro  |

The database draft has explicit `publicationBlockers`. Its connection-pressure workload
and worker-scaling trap are hypotheses, not proven behaviour. Published manifests cannot
retain blockers. Clearing them requires scenario-harness evidence, not just schema checks.

Follow the [runtime contract](../../docs/challenges.md) and the
[authoring guide](../../docs/content-authoring.md). Manifests are visible in this public
repository but must never be shipped as browser assets, returned by the API, or sent to
the assistant.
