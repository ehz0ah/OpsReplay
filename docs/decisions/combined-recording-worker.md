# Combined terminal and monitor recorder

Status: implemented locally, pending review. No AWS deployment or activation.

## Context

The Gateway already relays browser traffic and records monitor measurements and
recovery/outage events. Terminal storage adapters alone do not collect the original PTY
stream. Publishing monitor-only completion would make terminal playback incomplete while
claiming that the recording is complete.

## Decision

Keep the existing runner, supervisor, and `RECORDING` lease. Production composition always
supplies terminal collection and sealing. The internal runner still supports monitor-only
fixtures and legacy records. Terminal input ownership remains separate.

Start lease renewal before attachments. Collect the two streams concurrently, each from
its own committed cursor. Operational terminal failures cancel monitor work and prevent
completion. Source loss is different: consume the retained prefix, close the terminal
socket, and keep monitor collection running until lifecycle supplies a cutoff. Relevant
loss then publishes an incomplete recording once, fenced by the recorder generation.
Renewal continues independently during polling, uploads, and sealing. The lifecycle layer,
not the recorder, owns outcomes, the cutoff, and drain deadline.

Terminal coverage requires an event after the cutoff, a fully consumed source observed
strictly after the cutoff, or a fully consumed final exit. A same-millisecond observation
is insufficient because another event can share that timestamp. Keep cutoff-equal events.
Loss at or before the cutoff prevents sealing. A fully consumed exit closes the socket;
the collector waits for lifecycle without reading beyond the source's post-exit lifetime.

Seal the monitor at the fixed cutoff first, but defer publication. Freeze the committed
terminal checkpoint in `TERMINAL_SEAL`. Read one immutable committed page at a time. Limit
each S3 read by declared and actual size, canonical envelope, SHA-256 reference, caller
cancellation, and a seven-second total deadline. A missing committed object is an integrity
failure, not an empty recording.

Copy the included terminal prefix to immutable sealed-retention pages. Each transaction
checks the shared lease, fixed cutoff, drain deadline, and exact previous seal checkpoint
before it advances the sealed cursor. Reference keys omit generation. A restart can resume
a partly copied final source page. Exclusion proof includes that bounded source page and
must match both its canonical reference and the next excluded event. Completion conditions
check the immutable live reference in the same transaction.

Only after terminal sealing completes can the monitor transaction publish combined
completion. It validates the terminal seal and conditions both exact terminal snapshots.
For legacy records without terminal state, an absence condition prevents concurrent late
initialisation from bypassing this check. Stored covered drains do not reopen the terminal
source during takeover.

Skip unchanged empty terminal observations before a cutoff. Validate them without advancing
the durable checkpoint. Commit metadata changes and post-cutoff observations so coverage
still uses saved evidence. The page transaction enforces the lease without a redundant
up-front lease read.

Retry only pure DynamoDB transaction contention, up to four attempts with 25, 50, and
100 millisecond backoff and caller cancellation. Reuse the exact command and request token.
Do not retry failed conditions or unknown cancellation reasons. Exhausted contention is
isolated to its session. Keep uploads outside these retries. No per-session write queue is
added: it would not prevent cross-process conflicts and could delay lease renewal behind
slow work.

The lifecycle follow-up separates the 30-second task-coverage deadline from durable page
copying. `RECORDING_COVERAGE` freezes the exact covered terminal checkpoint, sealed monitor
reference, and final metric. It extends only the recording write deadline to a bounded
24-hour sealing window. Cleanup can stop the task after this receipt. Takeover resumes from
storage without contacting either task source. Delayed 3,000-page and coverage-takeover
regressions belong to that lifecycle change. Managed AWS timing remains unverified.

No additional AWS service or lease is added. Gateway IAM gains base-table `Query` restricted
to session keys and `s3:GetObject` restricted to live terminal pages. It cannot list or delete
recording objects or read sealed objects. Existing retention and encryption remain unchanged.

## Boundaries

This increment does not choose readiness, outcomes, incomplete reasons, or scores. It does
not implement shell markers, command evidence, captures, debrief, asciicast exports, playback
APIs, frontend work, or deployment. Raw PTY data is not proof of completed commands,
understanding, or causation. The source's existing bounded process-local lifetime is unchanged.

## Validation

Contract and unit tests cover exact cutoff coverage, exit and loss, canonical bytes,
bounded reads, cancellation, retry handling, resumed final pages, and upload failure.
DynamoDB Local exercises real seal transactions, lost responses, duplicate and conflicting
references, forged cutoff proof, takeover, deadline fences, and terminal-initialisation
and seal-change races against combined publication.

A production-composition test uses real DynamoDB Local transactions, the real monitor HTTPS
server, a synthetic terminal TCP source, and an injected S3 object adapter. It verifies both
durable cursors, sealed retention, combined completion, and work retirement. Container tests
exercise real PTY and monitor sources, interactive regressions, and the hardened Gateway
process. These tests do not establish AWS IAM, S3, Fargate, or ALB behaviour.

## Rollback

Revert this increment and retain the unused terminal adapters. The complete AWS path remains
disabled. Do not deploy a monitor-only worker over active combined sessions; let current
workers stop or finish before replacing them. Preserve committed references and do not
release another worker's lease. Unreferenced uploads expire under their retention policy.
