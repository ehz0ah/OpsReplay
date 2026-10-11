# Durable terminal page storage

Status: implemented locally, pending review. No AWS deployment or worker activation.

## Context

The Challenge exposes a bounded, nondestructive terminal source. The Gateway client
returns pages from an explicit cursor. A returned page is not durable evidence. A
replacement recorder needs the saved source identity, observation metadata, last event,
and cursor to detect gaps and continue without a second terminal input owner.

## Decision

Store original base64 PTY bytes in private canonical JSON pages. Asciicast is a derived
playback format, not the authoritative byte format. Each page has a SHA-256 object key,
checksum, size, source, sequence range, and timestamp range. Objects use conditional
S3 puts, S3-managed encryption, and the existing seven-day provisional retention tag.

Use `SESSION#<id>/TERMINAL_RECORDING` for the terminal checkpoint. Keep the existing
`RECORDING` item as the only recorder lease. A transaction checks its owner, generation,
expiry, and open recording or unexpired drain state, then atomically replaces the exact
previous terminal checkpoint and creates its immutable page reference. The terminal
reference key contains source and end sequence, not recorder generation. A takeover
cannot publish a second reference for an accepted range.

Upload before committing the reference and cursor. An upload failure cannot advance
state. A failed commit can leave only an unreferenced provisional object. Empty reads
update metadata without an S3 object. Exact retries and uncertain DynamoDB responses
are reconciled against committed state and the exact immutable reference. Concurrent
non-identical page commits fail rather than replacing accepted bytes.

Persist the last committed event and cumulative encoded event bytes. Validate source
identity, initial dimensions, monotonic observation and event clocks, shell progression,
permanent loss, and final exit across reconnects. Loss cannot clear; only the reserved
exit may extend an already frozen source. The source's 20 MB and 100,000-event lifetime
limits remain unchanged. Acknowledged trimming is not part of this increment.

## Boundaries and next integration

This increment adds adapters and their private contracts only. The composed worker still
records monitor measurements and recovery/outage events. Its current schema and
monitor-only sealing path are unchanged. No public schema, route, IAM permission,
terminal input ownership, readiness, outcome, or score changes.

The next worker increment must collect both streams under this lease, use the fixed
lifecycle cutoff, and require both final cursors before combined completion. It must
create sealed-retention copies of terminal data before publishing complete references.
Raw PTY input does not establish completed commands, understanding, or causation. Shell
markers, captures, debrief, and playback remain separate work.

## Validation

Private contract tests cover canonical encoding, byte preservation, strict checkpoint
validation, source and clock changes, loss, and final exit. Injected S3 and sink tests
cover checksum and retention settings, bounded conflict retries, cancellation, upload
ordering, failure acknowledgement, and caller mutation.

DynamoDB Local tests exercise real transactions, duplicate begin/commit calls, conflicting
bytes, lost responses, takeover, stale generations, drain-deadline checks, forged
references, checkpoint compare-and-swap, and corrupt state. Existing Gateway and
repository regressions must pass before publication. Local tests do not establish AWS
IAM, S3, or managed DynamoDB behaviour.

## Rollback

Remove the unused adapters and private contract. The active worker does not call them.
Unreferenced objects expire under the existing provisional policy. Do not delete an
active session partition or change another recorder's lease.
