# Public catalogue publication

Status: implemented; AWS publication validation pending.

The reviewed reference publisher derives an exact public `CatalogEntry` from the
published manifest. It stores the entry at `CATALOG#PUBLIC / ENTRY#challenge#<id>#<version>`.
Only public metadata enters this partition. Private manifests and admission pins keep
their existing keys. No secondary index or table scan is needed for catalogue discovery.

After validating and storing the private manifest, one DynamoDB transaction publishes
the admission and catalogue entry. Conditions allow an absent item or the exact same
data. This supports retry and backfill of a reviewed existing release without replacing
another version or reactivating retired content. An uncertain transaction response is
accepted only after strongly consistent reads confirm both complete projections.

Catalogue rows describe published versions, not live environment availability. The
start action still checks publication, grants, capacity, and request receipts. Existing
attempts retain their pinned version. Future content withdrawal must remove its public
row with the admission-status change; no withdrawal workflow is added here.

Publication IAM adds only the exact public partition to its existing conditional-write
permissions. It has no learner/session writes, scan, new index, or runtime activation.
