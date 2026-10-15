# Learner bootstrap reads

Status: implemented locally; Cognito and AWS integration pending.

`GET /v1/catalog` is public. A bounded, strongly consistent query reads only
`CATALOG#PUBLIC` metadata. A response uses at most 100 entries per page, default 50.
The curated catalogue is limited to 1,000 entries, 2 MiB of metadata, and 20 storage
pages per invocation. Larger libraries require a reviewed access-pattern change.
All filters and their available values use the same validated published dataset.
Cursors bind the filter set and dataset hash. A changed dataset or malformed cursor
returns 400 and requires a fresh first page. Neither private content nor user/session
partitions are queryable by this Lambda role.

`GET /v1/me` uses Cognito's verified subject and the configured ID-token audience.
A transactional read gets that learner's plan and active lock. An existing lock is
returned only after validating its owned session. It can name an ended session while
cleanup/finalisation still holds the lock. The browser reads session status rather
than assuming that a lock means a writable terminal. This read does not repair locks,
launch tasks, or update activity. Start remains authoritative for new admission.

The same resolver supplies effective access to account display and new session start.
Missing, Free, or expired Pro records yield `free/default/null`. A current Pro grant
returns `pro/grant/<expiry>`. A null Pro expiry has no deadline; the exact expiry instant
is already expired. Invalid stored data fails closed. Institutional provenance is not
implemented. Existing attempts continue to use their saved admission grant.

Both actions have separate bundles, roles, logs, timeouts, concurrency and throttling.
They use the existing API, fixed-origin CORS and default-off runtime gate. Opening
admission remains a separate switch. The additional two functions reserve eight
executions when runtime is enabled. No table, index, payment service or authentication
service is added.
