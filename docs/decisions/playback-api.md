# Bounded playback exports and owner reads

Status: implemented and tested locally. AWS activation and browser playback remain separate.
Date: 12 October 2026.

## Context and scope

PR 5 of the approved backend series builds on command evidence and debrief finalisation.
A saved terminal journal is not a browser playback format. Returning thousands of object
links at once would exceed bounded API responses. The same owner must be able to read a
saved debrief, live/final timeline, and retained playback without current-plan checks.

This increment adds exports and existing read contracts. It adds no product mode, service,
trigger, recorder lease, frontend player, assistant, scoring weights, or AWS deployment.

## Decision

- After confirmed task stop and schedule cleanup, publish the debrief, highlights,
  progress and matching-lock release first. Run ordinary export code afterwards in the
  existing reconcile/sweep actions. Playback does not gate result publication or retries.
- Keep lifecycle work indexed until export completion. Result publication creates a
  playback transition hint. Each pending 20-page pass updates that same bounded hint
  with its saved logical/physical cursors, not once per source page. Existing stream
  reconciliation continues promptly. The sweep recovers interrupted passes. Pending
  export is the normal `playback_pending` result, not a Lambda error. Completion removes
  work-index attributes atomically with the export checkpoint, while retaining the
  exact lifecycle data. Snapshot conditions prevent stale passes from restoring work.
- Pin recording, terminal, lifecycle, and final Monitor snapshots with a canonical hash.
  Process at most 20 source pages per pass. Save forward-only cursors, byte/count totals,
  terminal dimensions, UTF-8 tails, and OSC 133 filtering state. Partial Monitor scanning
  also saves its physical generation/sequence key to avoid repeated prefix scans.
- Validate immutable source references, hashes, envelopes, source identity, contiguous
  sequences, and timestamps. Complete exports use sealed prefixes. Partial exports omit
  post-cutoff frames. Missing or corrupt data fails closed before retention expiry.
- Upload content-addressed S3 objects before conditional reference/checkpoint transactions.
  Use an absent-object condition, checksum, encryption, and existing retention tags.
  Lifecycle IAM permits only the allowed retention tag and no extra tag keys. It denies
  retagging objects that already have the retention tag. Exports never change retention
  class. These use [S3 tagging condition keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/tagging-and-policies.html).
  Accept an existing upload only when length and SHA-256 match. Condition fixed source
  snapshots and previous progress. Recover uncertain writes from exact saved receipts.
- Save a small `MONITOR_FINAL` receipt atomically with recording completion. Finalisation
  can read final counters and durable event projections after source objects expire.
  Validate projection coverage. A legacy complete record without the receipt still needs
  its sealed S3 object. No migration or finalised-result backfill is included.
- At retention expiry, save complete/unavailable export progress and retire export work
  without object access. The independently saved debrief remains available.
- Save bounded highlights in the once-only debrief/progress/lock transaction, independent
  of playback state. Highlights use observed evidence, command times for possible harm,
  and Monitor times for outages/recovery. They do not assert execution, understanding,
  or causality.
- Deploy one Lambda each for get-debrief, list-timeline, and get-playback. Share validation
  and SDK configuration, not learner state. Each has its own role, bundle, timeout, and
  zero reserved concurrency. Routes use the existing conditional Cognito API.
- Check identity, request shape, ownership, saved grant, and saved-result relations before
  evidence reads. Missing and foreign sessions return the same 404. Reads never update
  liveness, state, recording/input ownership, or progress. Logs omit evidence and URLs.
- Page playback by metrics, terminal, then captures, scanning at most 25 reference rows.
  Cursors bind the session and fixed snapshot but never authorise access. Validate selected
  receipt continuity, source, bounds, and object checksums. Post-cutoff command captures
  are skipped. A page can be empty with a next cursor.
- Preserve the actual capture baseline/start/completion interval, including a pre-cutoff
  command captured during drain. Never clip a capture to imply an exact-cutoff snapshot.
- Resolve signing credentials once per request. Use fixed credentials and one whole-second
  signing time. All links share their actual expiry, at most 300 seconds and no later than
  retention or temporary credential expiry. Check all selected objects before any signing.

## Playback contract

Terminal chunks use asciicast v2 output, input, resize, and exit markers. Original bytes
remain private. OSC 133 command metadata is removed with bounded cross-chunk state.
Invalid or cut-off UTF-8 renders a replacement character. Recorded input must not execute.

The browser must keep one terminal across chunks and align relative times using each
track's `startedAt`. It must not reset the screen at each header. Metrics preserve saved
public Monitor frames and the sealed final sample. Captures retain honest read intervals.
The full timeline is a separate paginated read. Highlights are bounded and repeated per page.

`Playback.nextCursor` is now required, string or null. Playback `limit` is 1 to 25, default 25.
Timeline `limit` is 1 to 100, default 100. Reject duplicate, unknown, invalid, and stale
parameters with 400. Existing undeployed clients/fixtures must adopt the new field.

Active debrief/playback reads return `SESSION_ACTIVE`. Finalisation in progress returns
`DEBRIEF_PENDING` with a three-second retry interval. Once the debrief is saved, an absent
or valid unfinished export returns `PLAYBACK_PENDING` with the same retry interval.
Corrupt export state is an integrity error, not normal pending. Never-ready sessions have
no debrief. Timeline/playback return `RECORDING_EXPIRED` at retention. Saved debriefs
remain readable.

## Bounds and trade-offs

Terminal chunks: 256 KiB. Terminal aggregate: 171,200,000 bytes, derived conservatively
from six-fold JSON escaping of the 20,000,000-byte source allowance plus 512 bytes per
100,000 source events. This is an export ceiling, not a larger source budget or a measured
capacity claim. Metric chunks: 8 MiB. Aggregate: 40,960,000 bytes for 10,000 bounded frames.
HTTP responses: 256 KiB, with a 240 KiB timeline item budget.

Timeline rereads and sorts bounded history on every page, up to 5,000 commands, 10,000
Monitor events, and 500 reserved assistance events. This favours a simple authoritative
projection over a new materialised timeline writer. Invocation signals bound I/O, not
constant latency. Live readers use saved command and Monitor frontiers and exclude later
atomic publications without rejecting ordinary appends or lease changes. Live cursors
bind session, readiness and source identity, and seek after `(at, id)`. An empty poll
retains its cursor. A readiness/source change or final snapshot requires restart.
Delayed provisional events at or before the cursor and updates to an already returned
active command may require a refresh from the start. Final paging remains strictly
snapshot-bound. There is no hint/assistant event writer yet.

Read defaults: debrief 256 MiB/10 seconds. Timeline/playback: 512 MiB/25 seconds.
Integrations use 8/23 seconds, read burst four and rate two per second. These values and
lifecycle export throughput need measurement in the approved checkpoint. No AWS claim
follows from DynamoDB Local, in-memory object ports, local TLS/TCP, or CDK synthesis.

## Verification and rollback

Tests cover UTF-8/control splits, worst-case byte escaping, cutoff trimming, resumable
terminal/Monitor exports, upload failures/conflicts, source and finalisation races,
concurrent/lost writes, interrupted continuation, stale work retirement, early result
publication, normal pending handlers, empty sealed metrics, owner/grant checks, stable
live keyset cursors and strict final snapshots, capture intervals, expiry, checksum
failures, real SDK signing with dummy credentials, and composed recording/finalisation/read
integration. The PR records exact suite results.

Keep all actions disabled until peer review and explicit checkpoint approval. A code
rollback can revert this increment while preserving private source data. Before any
future deployed rollback, keep readers/exporters disabled and treat saved export/results
as immutable. No automated cleanup or migration is part of this change.
