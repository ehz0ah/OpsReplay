# Challenge content

Each directory holds one Challenge manifest. Wrong upstream port also has a
[local image and integration tests](wrong-upstream-port/README.md). The other images
are not implemented. All three manifests remain synthetic drafts with no published image digests, taken from the
preliminary report's initial Challenges:

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
