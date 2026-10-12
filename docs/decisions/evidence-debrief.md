# Command evidence, captures, and debrief finalisation

Date: 12 October 2026. Status: implemented and checked locally, not deployed.
Related: PR 4 of the five-PR recording series, after
[session lifecycle](session-lifecycle.md).

## Purpose and boundary

The recorder already saves terminal pages and Monitor measurements. This change
turns accepted records into reflection evidence and a deterministic debrief. It
also closes the ready-attempt lock boundary: confirmed task cleanup alone must not
permit a new attempt before progress and the saved result commit together.

No frontend, assistant grading, score weights, public playback route, content
publication, or AWS activation is added. Public Debrief and TimelineEvent schemas
stay unchanged. The current real-environment PRD applies, not the old simulated
state-machine handoff.

## Command evidence

The reference root Bash emits OSC 133 prompt, command-start, and completion
markers. PS0 reads the current history entry, not each command in a list. A
truncated command emits an explicit `133;T` loss marker. The browser relay removes
only OSC 133 metadata. Raw terminal pages retain their original bytes.

A pure resumable parser handles split UTF-8, OSC, and CSI sequences. It omits
alternate-screen output, bounds command text and excerpts, and retains unknown
completion as null. Program input is not copied into public command text. It does
not create another command or mark loss during long editor/pager sessions. Idle
shell input is a fallback, not proof of completion. Up to 20 commands and 256 KiB
commit directly with the terminal page. Larger derived sets use bounded immutable
content-addressed batches. The terminal transaction publishes exact batch hashes
with its parser frontier. Interrupted staging is invisible and cannot reserve a
command sequence for a competing page. The sealed path uses the same publication
model. Batches retain the existing 5,000-command and byte limits.

Sealing derives a separate parser and command receipts from the exact accepted
prefix. It never credits post-cutoff completion or output. A cutoff-open command
remains open. Loss, unfinished controls, and unfinished UTF-8 in that prefix
prevent complete recording. The source UUID and command sequence give stable IDs
across recorder takeover. Markers and output are learner-controlled. They do not
prove understanding, authentic execution, or causality.

## Safe interval captures

Only manifest-declared config and log paths are read. A Linux descriptor-anchored
walk holds each parent and uses NOFOLLOW, DIRECTORY, and NONBLOCK flags. Links,
directories, FIFOs, missing files, invalid UTF-8, and read-budget expiry produce
unavailable evidence, never access to another Monitor path. `unavailable` implies
`incomplete` and blocks complete recording. Byte, line, and aggregate excerpt bounds
produce only an `incomplete` warning. They do not remove a score derived from
complete terminal and Monitor evidence. Configuration observations store
bounded before/after blocks. This replaces the proposed unified-diff wire format:
a renderer can show the same blocks as a diff without an extra diff algorithm.
New log lines and a timestamped Monitor metric sample accompany each capture.
After measurement seal, that sample uses the fixed measurement cutoff.

The baseline precedes readiness. Monitor serialises captures, not terminal input,
and saves duplicate request receipts. `baselineAt` is the previous read start;
`startedAt` and `completedAt` describe the current read. Later commands and
background processes can change files throughout this interval. Log rotation or
truncation can lose unread lines and marks the interval incomplete, not unavailable.
After a bounded excerpt, the next log cursor starts at the observed file end. The
omitted tail stays part of the warned interval, not a later command's capture.
A byte-bound split UTF-8 tail is omitted without replacing invalid interior bytes.
Gateway keeps both warning and availability summaries sticky. A shared four-second
read budget is checked between filesystem operations and after each read. Expiry
omits evidence and marks it incomplete. The six-second HTTP deadline closes the
response, but neither deadline cancels a kernel filesystem operation already in
progress. Reads are limited to regular files on the task-local volume, not remote
mounts.

Gateway uploads the immutable capture before atomically saving its reference and
cursor under the shared recorder lease. Baseline, capture, and coverage transactions
use the shared bounded pure-contention retry. Exhaustion is a typed session error,
not a Gateway process failure. Failed conditions are not blindly retried.

Final task-dependent captures precede `RECORDING_COVERAGE`, which permits cleanup.
A saved parser checkpoint accompanies each live terminal page. Final drain seeks
the cutoff boundary using DynamoDB page metadata and reparses at most one S3 page.
It captures the complete accepted command set, including its cutoff-open command,
and saves an exact `CAPTURE_COVERAGE` receipt. Coverage checks this receipt and
capture state atomically before it extends the sealing deadline. Capture writes
are fenced after that receipt. Covered takeover seals terminal pages using only
saved objects and checks that its sealed parser equals the capture proof. It never
calls the stopped Monitor. Combined completion conditions exact parser/capture
snapshots and rejects a missing capture or parser gap. Final captures can
extend past the outcome cutoff; their interval states this explicitly. They are
not exact-cutoff filesystem snapshots and do not enter score or observed-evidence
matching.

Limits: 5,000 commands and captures; 20,000,000 retained bytes each for command
receipts and captures; 16 KiB per command event and watched file; 4,000 characters
per command/excerpt; 20 paths; 200 new lines per log; 256 KiB per capture. The
command publication uses at most 20 commands and 256 KiB per batch, not per source
page. Actual total-limit omission marks loss, not a silently complete result.

Private baseline, capture objects, and saved capture state now require an explicit
`unavailable` flag. References retain their existing `incomplete` warning field.
These unpublished contracts change together. No deployed data needs migration.
Do not mix old and new Monitor/Gateway versions or downgrade over active captures.
Old records without the flag fail closed rather than guessing whether loss was
ordinary truncation or unsafe evidence.

## Environment publication prerequisite

The application stack currently accepts an externally published environment task
revision. It does not define that task. `infra/environment-watched-volume.ts`
supplies and tests its required publication layout: one task-local ephemeral
volume at `/opsreplay/watched`, Challenge writable, Monitor read-only, and
`OPSREPLAY_WATCHED_FILES=1` only in the Challenge. The reference image prepares
synthetic watched directories before services start and refuses that option
without a mount. No Monitor credential belongs in this volume.

This helper is not wired to a nonexistent environment resource. Local Docker tests
exercise the equivalent layout. A later approved publication/deployment checkpoint
must use the helper, pinned images, private manifest/bootstrap delivery, no task
IAM role, and the existing network restrictions. Fargate mount and isolation
behaviour still need AWS tests. No Challenge becomes published in this PR.

## Deterministic debrief and once-only commit

Admission and session pins now require the canonical manifest SHA-256. Publication
must first store the schema-valid immutable private item under
`CONTENT#challenge#<id> / MANIFEST#<version>#<sha256>`, then publish its admission
snapshot. The reader checks hash, version, identity, and a 256 KiB bound. Existing
attempts retain their pin. No deployed/published content currently needs migration.
Future publication must run the repository's authored-pattern and reference checks;
JSON Schema alone does not establish useful or safe authored regular expressions.

Complete finalisation reads bounded sealed command receipts and one integrity-checked
Monitor object. A saved sealed reference can come from an earlier recorder generation
after covered takeover, but never a future generation. It does not reparse thousands of PTY objects in Lambda. Partial
finalisation reads saved command receipts and atomic `MONITOR_EVENTS` page
projections, with no dependency on expired provisional S3 objects and no invented
final counters. Its score is always null. Point reads and bounded key queries use
the invocation deadline. Object reads enforce length, SHA-256, stream cleanup,
and a seven-second deadline. Large attempts and Lambda durations still need AWS
measurement; local tests are not capacity evidence. Reconcile uses 512 MiB and
sweep uses 1,024 MiB, because sweep can hold five bounded evidence sets at once.
These are explicit checkpoint defaults, not measured optimal sizes.

Evidence matching uses a command and every output pattern from the same completed
command within readiness/outcome bounds. Outages come from Monitor events. Trap
matches are timing associations only. The response includes the first 50 outage
and possible-harm details allowed by the existing schema; complete raw score
components count all saved outages. Full detail remains in the recording timeline,
which the next PR exposes. No ranking or combined score is invented.

Reconcile and sweep call the same ordinary finaliser code after confirmed task stop
and schedule deletion. No additional Lambda, trigger, or Lambda-to-Lambda call is
needed. Their narrow roles add private manifest GetItem, session Query, and sealed
Monitor GetObject. The transaction conditions saved session, recording, lifecycle,
progress, and lock snapshots, then writes FINALISED, DEBRIEF, availability and
progress, retires work, and releases only the matching lock. Platform errors do not
increment completed attempts. Saved results bypass private content reads on retry.

## Failure, validation, and rollback

Uploads can leave unreferenced objects, which retention removes. Cursor commits
never precede upload. Conflicting snapshots and stale leases cannot publish a
complete result. A failed finaliser leaves cleanup confirmed, the work discoverable,
and the matching learner lock held for retry. Missing or corrupt content fails
closed, not with a fabricated explanation or score.

Validation covers real PTY markers; split parser replay and truncation; Linux
unsafe-file reads and duplicate captures; capture pagination/open cutoff command;
DynamoDB Local atomic persistence, takeover, lost responses, and validation/commit
races; deterministic fixture parity; incomplete evidence; confirmed cleanup and
once-only progress; generated disabled IAM definitions; application regressions
and runtime images. Exact commands and results belong in the PR body.

Rollback before deployment is a revert. After future publication, retain private
manifest items and published task revisions for existing attempts. Do not clear
active locks or replace saved outcomes to bypass finalisation. A runtime rollback
must keep in-flight work readable or allow it to drain with the compatible version.
