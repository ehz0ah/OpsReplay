# Data model

Status: proposed v0.2 persistence contract. Private records and wire types are separate.
Public responses use explicit allowlists. Never serialise a private record and remove a
few known fields afterwards.

## Records

| Record            | Contents                                                                                                                                                                                                                                                                                  | Visibility                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| ContentVersion    | Content ID, immutable version, mode, hash, status, tier, category, plan, provenance. Challenges add the task definition revision and image digests                                                                                                                                        | Catalogue subset public                                     |
| ChallengeManifest | Environment, traffic, dashboard, alert, validators, probes, planted fault, reference fix, traps, hints, debrief                                                                                                                                                                           | API, gateway, monitor, and test harness only                |
| ReviewBundle      | Diff, context, language, related Challenges, findings                                                                                                                                                                                                                                     | Exercise projection before submission, findings after       |
| LearnEntry        | Markdown metadata and body rendered at build time                                                                                                                                                                                                                                         | Free entries public, Pro entries after an entitlement check |
| Plan              | Owner, plan, source, expiry, cohort                                                                                                                                                                                                                                                       | Owner, through `GET /v1/me`                                 |
| Session           | Owner, saved access grant and limits, Challenge ID and version, digests, attempt, status, reason, immutable launch arguments, provisioning deadline, schedule name, task ARN, task address, monitor secret and certificate pin, times, `lastSeenAt`, counters, recovery state, hint count | Public projection only                                      |
| TimelineEvent     | Command, monitor, assistance, or lifecycle event                                                                                                                                                                                                                                          | Owner                                                       |
| Capture           | Requesting command sequence, `baselineAt`, `startedAt`, `completedAt`, bounded configuration before/after blocks, new log lines, timestamped metric sample. Association is not causation                                                                                                  | Owner, through playback links                               |
| Recording         | Status, incomplete reason, fixed cutoff and drain deadline, recorder generation and lease expiry, saved cursors, immutable object references, and authoritative recording retention boundary                                                                                              | Status public, objects through playback links               |
| TerminalTicket    | Ticket hash, owner, session, expiry                                                                                                                                                                                                                                                       | API and gateway only                                        |
| TerminalInput     | Monotonic connection generation and owning connection ID. The terminal server enforces the installed generation                                                                                                                                                                           | Gateway only                                                |
| Debrief           | Observed evidence, attempted checks, possible harmful actions, measured outages, score components, assistance                                                                                                                                                                             | Owner, after recording is sealed                            |
| Proposal          | Session, owner, command, rationale, caution flag, expiry, delivery status, private delivery token, fixed acknowledgement deadline and input generation                                                                                                                                    | Owner projection without delivery token or generation       |
| ConversationTurn  | Session or submission, request hash, worker token, fixed expiry, status, text, proposals, token usage                                                                                                                                                                                     | Owner projection, excluding hash and worker token           |
| ReviewSubmission  | Owner, saved access grant, exercise version, flags and concerns, match result, answer-informed flag                                                                                                                                                                                       | Owner                                                       |
| Progress          | Owner, content ID, first-attempt outcome and score, attempt count, last attempt, assisted flag                                                                                                                                                                                            | Owner                                                       |
| Receipt           | Owner or resource scope, request ID, payload hash, result pointer                                                                                                                                                                                                                         | Server only                                                 |

Learn entries and catalogue reads never create sessions. Code Review stores written
concerns for reflection and never scores them.

## DynamoDB keys

One table is sufficient initially. Normal requests read by key and never scan. Item
names are a storage convention, not part of the HTTP contract.

| PK                       | SK                                                         | Contents                                                                                  |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `USER#<id>`              | `PROFILE`                                                  | Minimal account preferences                                                               |
| `USER#<id>`              | `PLAN`                                                     | Plan, source, expiry, cohort                                                              |
| `USER#<id>`              | `ACTIVE`                                                   | Active-session lock holding the session ID                                                |
| `USER#<id>`              | `PROGRESS#<contentId>`                                     | Learner progress                                                                          |
| `USER#<id>`              | `START#<requestId>`                                        | Session start receipt                                                                     |
| `USER#<id>`              | `REVIEWREQ#<requestId>`                                    | Review submission receipt                                                                 |
| `CONTENT#<id>`           | `VERSION#<version>`                                        | Server-only published Challenge admission snapshot                                        |
| `SESSION#<id>`           | `STATE`                                                    | Private session record                                                                    |
| `SESSION#<id>`           | `RECORDING`                                                | Lease, cursors, references, and nullable `retainUntil`                                    |
| `SESSION#<id>`           | `CHUNK#<source>#<generation>#<sequence>`                   | One immutable provisional monitor object reference and its sequence range                 |
| `SESSION#<id>`           | `TERMINAL_RECORDING`                                       | Terminal source metadata, cursor, last committed event, and encoded event bytes; no lease |
| `SESSION#<id>`           | `TERMINAL_CHUNK#<source>#<sequence>`                       | One immutable terminal page reference; identity does not change at takeover               |
| `SESSION#<id>`           | `TERMINAL_SEAL`                                            | Frozen source checkpoint, cutoff, sealed cursor, page count, bytes, and completion        |
| `SESSION#<id>`           | `TERMINAL_SEALED_CHUNK#<source>#<sequence>`                | One immutable sealed terminal page reference                                              |
| `CONTENT#challenge#<id>` | `MANIFEST#<version>#<sha256>`                              | Immutable private manifest, retained for admitted attempts                                |
| `SESSION#<id>`           | `COMMAND_PARSER`                                           | Live bounded parser snapshot and source cursor                                            |
| `SESSION#<id>`           | `COMMAND#<sequence>`                                       | Immutable live command or exact overflow-batch publication                                |
| `SESSION#<id>`           | `SEALED_COMMAND_PARSER`                                    | Parser for the exact accepted terminal prefix                                             |
| `SESSION#<id>`           | `SEALED_COMMAND#<sequence>`                                | Immutable cutoff command or exact overflow-batch publication                              |
| `SESSION#<id>`           | `COMMAND_CHECKPOINT#<terminal-cursor>`                     | Immutable published parser checkpoint for bounded cutoff reconstruction                   |
| `SESSION#<id>`           | `COMMAND_BATCH#<sha256>` / `SEALED_COMMAND_BATCH#<sha256>` | Bounded immutable overflow batches, visible only through a published command receipt      |
| `SESSION#<id>`           | `CAPTURE_COVERAGE`                                         | Exact cutoff parser, terminal checkpoint and durable capture state before task cleanup    |
| `SESSION#<id>`           | `CAPTURE_STATE`                                            | Baseline, capture cursor/sequence, byte total and incompleteness                          |
| `SESSION#<id>`           | `CAPTURE#<sequence>`                                       | Immutable capture object reference and read interval                                      |
| `SESSION#<id>`           | `MONITOR_EVENTS#<ending-sequence>`                         | Atomic bounded live Monitor event page for partial finalisation                           |
| `SESSION#<id>`           | `EVENT#<epochMillis>#<source>#<n>`                         | Timeline event, time-ordered                                                              |
| `SESSION#<id>`           | `TICKET#<sha256>`                                          | Terminal ticket owner, session, ISO expiry, and numeric `ExpiresAt`                       |
| `SESSION#<id>`           | `INPUT`                                                    | Input generation and owning connection, independent of recorder lease                     |
| `SESSION#<id>`           | `REQUEST#<requestId>`                                      | End and hint receipts                                                                     |
| `SESSION#<id>`           | `HINT#<hintId>`                                            | Released hint and time                                                                    |
| `SESSION#<id>`           | `PROPOSAL#<proposalId>`                                    | Assistant command proposal                                                                |
| `SESSION#<id>`           | `TURN#<turnId>`                                            | Challenge assistant turn                                                                  |
| `SESSION#<id>`           | `CONVERSATION`                                             | Active turn ID and fixed expiry                                                           |
| `SESSION#<id>`           | `FINALISED`                                                | Marker that the finaliser has run                                                         |
| `SESSION#<id>`           | `DEBRIEF`                                                  | Derived debrief and score components                                                      |
| `SESSION#<id>`           | `MONITOR_FINAL`                                            | Immutable cutoff sample/counters receipt, atomic with complete recording                  |
| `SESSION#<id>`           | `PLAYBACK_EXPORT`                                          | Fixed source hash, resumable cursors, decoder tails, byte/count bounds, completion        |
| `SESSION#<id>`           | `PLAYBACK#<kind>#<ending-sequence>`                        | Immutable terminal or metric export reference                                             |
| `SESSION#<id>`           | `PLAYBACK_HIGHLIGHTS`                                      | Bounded observed-only highlights, atomic with the debrief                                 |
| `REVIEW#<id>`            | `STATE`                                                    | Review submission and match result                                                        |
| `REVIEW#<id>`            | `TURN#<turnId>`                                            | Code Review assistant turn                                                                |
| `REVIEW#<id>`            | `CONVERSATION`                                             | Active turn ID and fixed expiry                                                           |

Event sort keys use the event time, a stable source stream ID, and its sequence number.
Reconnects preserve these IDs. API events use their request identity. The Gateway
parser assigns command sequence numbers from one stable terminal source. The Monitor
assigns capture sequences on first request. These private receipts are implemented;
the generic time-ordered EVENT layout remains a design convention.

An owner index keyed by user and creation time lists sessions and submissions. The
`unfinished-work` sparse index uses top-level `WorkPK` and `WorkSK` attributes. Recording
work uses `WorkPK = RECORDING` and
`WorkSK = <session-created-at>#SESSION#<session-id>`. The index holds unfinished lifecycle work, including provisioning and terminal sessions
awaiting cleanup, keyed by the next check time. The sweep handles startup deadlines,
missing schedules, heartbeats, and cleanup, even if the client never retries.
Indexes are eventually consistent. Coordinating writes use strongly consistent point
reads. Handlers return the committed record, so an index delay never hides a new session.
Active conversations also enter the work index by turn expiry. Expiry is an application
condition, not a DynamoDB TTL deletion. A delayed sweep cannot block a new request,
because admission also recovers an expired turn through a conditional write.

## Private S3 layout

| Key prefix                                           | Contents                                  | Writer              |
| ---------------------------------------------------- | ----------------------------------------- | ------------------- |
| `content/challenges/<id>/<version>/`                 | Manifest and debrief assets               | Content publication |
| `content/reviews/<id>/<version>/`                    | Review bundle                             | Content publication |
| `content/learn/<id>/<version>/`                      | Rendered Pro Learn entry                  | Learn build step    |
| `sessions/<sessionId>/terminal/<generation>/live/`   | Byte-preserving private JSON source pages | Gateway             |
| `sessions/<sessionId>/terminal/<generation>/sealed/` | Exact-cutoff private JSON terminal pages  | Gateway             |
| `sessions/<sessionId>/playback/terminal/<source>/`   | Derived asciicast v2 chunks               | Lifecycle finaliser |
| `sessions/<sessionId>/playback/metrics/<source>/`    | Derived public Monitor frame chunks       | Lifecycle finaliser |
| `sessions/<sessionId>/metrics/<generation>/`         | Metric series chunks                      | Gateway             |
| `sessions/<sessionId>/captures/<generation>/`        | Per-command captures                      | Gateway             |

Published content keys are immutable, with a hash in the catalogue manifest. The
frontend bucket holds only the static application and free Learn pages. Browsers read
session objects only through pre-signed links from the playback route. Terminal
recordings and log captures exceed DynamoDB's item size, which is why they live in S3.

## Conditional writes

| Operation                | Write and condition                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start                    | Transaction: start receipt absent, active lock absent, session created in `provisioning` with a fixed deadline, schedule name, and launch arguments                                                              |
| Save task                | Set ARN only if absent or equal to this ARN. A terminal session still records a late ARN for cleanup, never returns to `provisioning`                                                                            |
| Ready                    | Update conditional on `provisioning`, before its deadline, monitor health, and an active recorder lease with initialized `startedAt`. Save `readyAt` and `endsAt`. Task address is already saved for attachment. |
| Outcome                  | Transaction conditional on active status: outcome and `endedAt`, recording set to `draining` with a fixed cutoff and drain deadline. The first outcome wins                                                      |
| End                      | Transaction: the outcome update and the end receipt                                                                                                                                                              |
| Heartbeat                | Update `lastSeenAt` conditional on `ready`                                                                                                                                                                       |
| Terminal admission       | Transaction: confirm the owned session is `ready` at the same task address, delete the same unexpired ticket, and replace `INPUT` with the next generation and a server-generated connection ID                  |
| Hint                     | Transaction: hint item absent, session hint count equal to the expected value, receipt                                                                                                                           |
| Input authorization      | Before input, resize, or heartbeat, strongly read the session and `INPUT`; require a `ready` session and the same connection ID and generation. Terminal acknowledgement is required before browser readiness    |
| Proposal dispatch        | Change `pending` to `dispatching` with a fixed token, conditional on expiry, active session, and input owner                                                                                                     |
| Proposal acknowledgement | Same token only. Record `accepted` after terminal acceptance, `pending` only after definite non-delivery, otherwise `unknown`. No automatic resend                                                               |
| Recorder claim           | Claim an absent or expired lease and increment its generation. Renewal requires the same owner and generation                                                                                                    |
| Recording append         | Save cursors and object references only after upload, with the current unexpired lease and recording still open. Event identity makes retries idempotent                                                         |
| Seal recording           | Conditional on `draining`. `complete` requires the current recorder lease, all final cursors saved without gaps, and time before the drain deadline. Otherwise use `incomplete` and a reason                     |
| Finalise                 | Transaction: `FINALISED` absent, recording sealed, task confirmed stopped, debrief written if ready was reached, progress updated, lock released only if it still names this session                             |
| Start turn               | Transaction: turn ID absent and conversation slot absent. Store hash, worker token, fixed expiry, `running` turn, and active slot                                                                                |
| Expire turn              | Transaction: turn still `running`, expiry reached, slot still names the turn. Set `interrupted` and clear the slot                                                                                               |
| Finish turn              | Transaction: `running`, matching worker token and active slot, before expiry. Save terminal result and allowed proposal, then clear the slot                                                                     |

Application receipts, not client-token windows, enforce idempotency for the life of a
session. `RunTask`'s client token covers only the short gap between the start transaction
and the task launch. Recovery never calls `RunTask` beyond the saved provisioning
deadline or after an outcome. It discovers late tasks by session tag, `startedBy`, and
ECS task events and stops them. All callers use the same saved launch arguments.
Canonical request hashing covers the request body, not transport
headers. A retry checks ownership, then the receipt. Same ID and same hash returns the
saved result. Same ID and a different hash returns `IDEMPOTENCY_CONFLICT`.

Receipt scope includes the operation and owner, and its hash includes the target resource
and version. Current publication, plan, and admission limits apply only after a receipt
miss. Existing resources use their saved access grant, including after plan expiry.
Cleanup is never conditional on the current paid plan. See the [API rules](api.md#common-rules).

Input generations and recorder generations are different counters. The terminal server
serializes generation installation, manual input, and proposal delivery. It keeps a
bounded per-attempt delivery ledger keyed by proposal token, with a no-resend marker
before a PTY write and acceptance after the write. Losing this ledger ends the attempt
as a platform error. A database `dispatching` write alone never proves a command ran.

Stream-triggered handlers, such as the finaliser, must tolerate redelivery. Every effect
they have is conditional or naturally idempotent, such as `StopTask` on a stopped task.
The finaliser does not call `StopTask` before recording is sealed. The sweep seals a
timed-out drain as incomplete and resumes cleanup. Late recorder completions cannot
overwrite a sealed recording or its debrief. Terminal sessions remain in the work index
until all cleanup finishes, including sessions that never became ready.

Provisional S3 recording objects use the recorder generation and source sequence in
their keys. Terminal DynamoDB references omit generation: the source and ending sequence
identify an accepted page across takeovers. The terminal checkpoint and immutable
reference commit in one transaction that checks the existing `RECORDING` lease and the
exact previous checkpoint. Empty reads save metadata without an object. These terminal
adapters are connected to the composed worker locally. `TERMINAL_SEAL` freezes a covered
checkpoint and advances only after each immutable sealed page commits. Exclusion proof
identifies the next event in an exact committed live page. Combined publication conditions
both terminal snapshots and the shared lease. See the
[storage decision](decisions/gateway-terminal-persistence.md) and
[combined-worker decision](decisions/combined-recording-worker.md).

The canonical sealed monitor object is referenced directly by `RECORDING`, so a
final sequence that matches the last provisional page cannot collide with that page.
Recording JSON carries an application `schemaVersion`; this does not require S3 bucket
versioning. Event
IDs preserve the original source and sequence across reconnects, so replaying a buffered
event does not append it twice. The final debrief uses the sealed set of references,
not a fresh scan of the S3 prefix. Terminal outcomes with incomplete recording store a
null score. They never substitute zero for missing counters.

The reference terminal source now keeps one process-generated UUID, contiguous event
sequences, and a nondestructive cursor. Its temporary journal retains at most
20,000,000 serialized event bytes and 100,000 events for the whole attempt, not the
unread backlog. Reserve 128 bytes and one event inside those limits for final exit.
`limit_exceeded` or `data_gap` freezes normal data and exposes the first loss time.
Finalization still appends one exit with the next retained sequence and preserves loss.
One large output can end normal recording for the remaining attempt, even with current
readers. Relevant loss produces an incomplete combined recording with a null score.
It contains raw input/output, dimensions, and exit, not command events.
This is separate from durable recording storage and does not consume a recorder lease.
See the [terminal source decision](decisions/terminal-recording-source.md).

Gateway terminal persistence and combined cutoff sealing are implemented locally.
Recording completion now requires both terminal and monitor final cursors when terminal
state exists. Legacy monitor-only records use an absence condition to reject concurrent
terminal initialisation. Lifecycle integration and debrief finalisation are tested
locally. Resumable exports and owner read APIs are also implemented, but remain disabled.
Finalisation requires private manifest hash pins, confirmed cleanup, completed matching
exports, and matching session/recording/lifecycle/terminal/final-Monitor snapshots.
Live parser and command receipts commit with terminal pages. Sealed parser and receipts
commit with cutoff pages. Capture uploads precede atomic reference/cursor writes under
the same lease. Combined completion rejects parser loss, incomplete controls/UTF-8,
and missing required captures or unavailable capture evidence. Capture objects,
baselines, and `CAPTURE_STATE` distinguish the `incomplete` excerpt warning from
`unavailable` missing or unsafe evidence. Both summaries are sticky, but only
availability gates completion. References retain the warning for playback. These
unpublished private fields require compatible Monitor and Gateway versions.
Incomplete finalisation uses safe saved command and
Monitor event projections, never invented final counters. See the
[evidence/debrief decision](decisions/evidence-debrief.md).
Exports use content-addressed keys with source sequence ranges. Uploads carry the existing
sealed/provisional retention tag, SHA-256 checksum, encryption, and an absent-object
condition. A retry accepts only an equal existing object. Each checkpoint/reference
transaction conditions the fixed source snapshots and previous progress. A completed
export is conditioned again in the result/progress/lock transaction.

`MONITOR_FINAL` is saved in the recording seal transaction, so delayed finalisation can
use final counters and bounded `MONITOR_EVENTS` projections after S3 expiry. A projection
gap fails closed. Legacy complete records without this receipt require their sealed S3
object. There is no backfill for earlier finalised results. These record formats are
undeployed.

The export cap remains independent of the source's encoded-byte cap. Terminal chunks are
at most 256 KiB. The aggregate ceiling is 171,200,000 bytes: six times the source's
20,000,000-byte budget plus 512 bytes for each of at most 100,000 events. This conservative
bound covers JSON escapes and per-chunk syntax; it is not a measured workload or a larger
source allowance. Metric chunks are at most 8 MiB with an aggregate ceiling of 40,960,000
bytes for at most 10,000 bounded frames. Preparation handles at most 20 source pages per
pass. Playback scans at most 25 reference rows per page. Timeline rereads at most 5,000
commands and 10,000 Monitor events plus 500 reserved assistance events. It has a 240 KiB
event-response budget and an invocation deadline, not a constant-time guarantee.
See [the playback decision](decisions/playback-api.md).

## Bounds and retention

DynamoDB has a 400 KB item limit. Proposed application limits, to validate with the
first image:

| Item                 | Limit                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| Timeline event       | 16 KB, with command text and output excerpt each capped at 4,000 characters |
| Commands per attempt | 5,000                                                                       |
| Command receipts     | 20,000,000 retained bytes per attempt                                       |
| Captures             | 5,000 captures and 20,000,000 retained bytes per attempt                    |
| Watched file         | 16 KiB; at most 20 allowlisted paths                                        |
| Private manifest     | 256 KiB, canonical SHA-256 pinned by admission                              |
| Capture              | 256 KiB, with at most 200 new lines per watched log                         |
| Terminal recording   | 20 MB per attempt, after which recording stops and the learner is told      |
| Terminal input       | 64 KiB per second per session at the gateway                                |
| Chat input           | 4,000 characters                                                            |
| Review flags         | 50 per submission, 2,000 characters per concern                             |

Reject limits before side effects with a stable error.

Recordings contain everything the learner typed or printed, which may include secrets
they paste by mistake. Live recording pages carry the `opsreplay-retention=provisional`
S3 tag and expire seven days after object creation. Sealed recordings carry
`opsreplay-retention=sealed` and expire after 30 days. This bounds failed uploads and
superseded data without treating an S3 object as authoritative. `RECORDING.retainUntil`
is null while active. It becomes the fixed cutoff plus 30 days for a complete recording,
or the recording start plus seven days for an incomplete recording. Readers check this
record before following object references. At or after the boundary, playback returns
`410 RECORDING_EXPIRED`. Before it, a missing referenced object is an integrity failure.
The debrief does not expire with the recording. See the
[recording retention decision](decisions/recording-retention.md).

Deleting a learner removes their table items, session prefixes, conversations, and
submissions. The evaluation owner owns the request. One-session deletion is allowed
only after the session is terminal, recording is `complete` or `incomplete`, recording
work is retired, and the owner's active lock does not name the session. It deletes the
S3 prefix before the `SESSION#<sessionId>` partition, then deletes the matching
`USER#<ownerId>/START#<requestId>` receipt. It verifies all three locations before it
confirms deletion and never changes a lock for another session. The owner-authorized
deletion action and retention periods for non-recording data remain required before the
external pilot.

## Versioning

Published content is immutable. Changing a Challenge image, the monitor image, the
manifest, validators, traps, hints, or debrief text creates a new Challenge version with
its own task definition revision, image digests, and canonical manifest SHA-256.
Publication stores the private `MANIFEST#<version>#<sha256>` item before its admission
snapshot. Existing sessions keep their pins and need the immutable private item until
finalisation. Existing unpublished fixtures were updated; there is no deployed content
migration in this increment.
Playback of an old session uses only its stored data, never a new environment.

## Repository and launcher ports

Implement these before UI or LLM integration:

- Sessions: `createSession`, `getOwnedSession`, `markReady`, `recordOutcome`,
  `recordHeartbeat`, `appendTimelineEvent`, `listTimeline`, `issueTicket`,
  `consumeTicket`, and `finalise`.
- Content and plans: `getContentVersion` and `getPlan`.
- Environments: `launch`, `stop`, `describe`, and `listRunning`, with a Fargate adapter.

Use the real DynamoDB adapter against DynamoDB Local for concurrency and duplicate-request
tests. Local Docker is for image and component checks, not a second platform launcher.
Add review and conversation ports when those work packages start.

## Implemented admission records

The start adapter stores `{ PK, SK, data }`. It reads keys consistently and writes the
receipt, active lock, and session in one transaction. Each put requires an absent key.
The same transaction checks the complete `data` snapshots for content, plan, and progress.
Missing plan/progress records are checked as absent. Concurrent publication, grant, or
finalisation changes cannot use stale admission data.

- Content admission data contains the public Challenge reference, alert, dashboard
  descriptors, hint count, plan, per-plan time limits, and pinned task/image references.
  It does not load the full manifest or unreleased hints. A future publication step
  writes this snapshot only after content checks pass. A published snapshot requires an
  explicit Pro time limit greater than its Free limit. Draft content can leave the Pro
  setting unset. Test fixtures are synthetic.
- Plan data is `{ plan, expiresAt }`. A missing grant uses Free. Invalid stored data
  fails closed. A Pro grant must not have expired at admission. Time limits are never
  invented in code.
- Progress admission data is `{ completedAttempts }`, counting finalised non-error
  attempts for that Challenge ID. The later finaliser must update it before releasing
  the active lock. Zero means the next attempt is `first`. At 1000, admission rejects
  another attempt because the public schema caps the attempt number at 1000.
- A receipt contains the owner, canonical request ID, payload hash, and session ID.
  It has no TTL. Replay reads the owned session, including a later terminal result.
- The private session contains the public view, owner, saved access grant, content pins,
  provisioning deadline, and schedule name. The active lock contains its session and
  request IDs. Public responses use explicit nested projections, never the whole item.

The current start increment stores the exact ECS arguments, monitor secret, public
monitor certificate, task ARN, private task address, provisioning and launch-recovery
deadlines, schedule name, cleanup state, and a nullable
`launchFailure` containing the confirmed rejection kind and normalized reason codes.
These private fields never reach a public session projection. Launch arguments contain
an S3 environment-file ARN, not the secret value. The key is bound to the session ID.
The recovery schedule uses the saved schedule name plus `-recovery`. Both callbacks
exist before `RunTask`. A confirmed launch error is replayed from `launchFailure`.
These fields revise an undeployed record format. Old local test records must be rebuilt.
Provisioning timeout cleanup releases the active
lock only after a saved task is stopped or the bounded launch-recovery period passes with
no active task. The recording-work attributes are written locally, but their global
secondary index is not deployed yet. Readiness and the reconciliation sweep remain to
be implemented before the API is enabled.
