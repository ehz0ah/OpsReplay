# Data model

Status: proposed v0.2 persistence contract. Private records and wire types are separate.
Public responses use explicit allowlists. Never serialise a private record and remove a
few known fields afterwards.

## Records

| Record | Contents | Visibility |
| --- | --- | --- |
| ContentVersion | Content ID, immutable version, mode, hash, status, tier, category, plan, provenance. Challenges add the task definition revision and image digests | Catalogue subset public |
| ChallengeManifest | Environment, traffic, dashboard, alert, validators, probes, planted fault, reference fix, traps, hints, debrief | API, gateway, monitor, and test harness only |
| ReviewBundle | Diff, context, language, related Challenges, findings | Exercise projection before submission, findings after |
| LearnEntry | Markdown metadata and body rendered at build time | Free entries public, Pro entries after an entitlement check |
| Plan | Owner, plan, source, expiry, cohort | Owner, through `GET /v1/me` |
| Session | Owner, saved access grant and limits, Challenge ID and version, digests, attempt, status, reason, immutable launch arguments, provisioning deadline, schedule name, task ARN, task address, monitor secret and certificate pin, times, `lastSeenAt`, counters, recovery state, hint count | Public projection only |
| TimelineEvent | Command, monitor, assistance, or lifecycle event | Owner |
| Capture | Requesting command sequence, `baselineAt`, `startedAt`, `completedAt`, configuration diffs, new log lines, metric sample. Association is not causation | Owner, through playback links |
| Recording | Status, incomplete reason, fixed cutoff and drain deadline, recorder generation and lease expiry, saved cursors and immutable object references | Status public, objects through playback links |
| TerminalTicket | Ticket hash, owner, session, expiry | API and gateway only |
| TerminalInput | Monotonic connection generation and owning connection ID. The terminal server enforces the installed generation | Gateway only |
| Debrief | Observed evidence, attempted checks, possible harmful actions, measured outages, score components, assistance | Owner, after recording is sealed |
| Proposal | Session, owner, command, rationale, caution flag, expiry, delivery status, private delivery token, fixed acknowledgement deadline and input generation | Owner projection without delivery token or generation |
| ConversationTurn | Session or submission, request hash, worker token, fixed expiry, status, text, proposals, token usage | Owner projection, excluding hash and worker token |
| ReviewSubmission | Owner, saved access grant, exercise version, flags and concerns, match result, answer-informed flag | Owner |
| Progress | Owner, content ID, first-attempt outcome and score, attempt count, last attempt, assisted flag | Owner |
| Receipt | Owner or resource scope, request ID, payload hash, result pointer | Server only |

Learn entries and catalogue reads never create sessions. Code Review stores written
concerns for reflection and never scores them.

## DynamoDB keys

One table is sufficient initially. Normal requests read by key and never scan. Item
names are a storage convention, not part of the HTTP contract.

| PK | SK | Contents |
| --- | --- | --- |
| `USER#<id>` | `PROFILE` | Minimal account preferences |
| `USER#<id>` | `PLAN` | Plan, source, expiry, cohort |
| `USER#<id>` | `ACTIVE` | Active-session lock holding the session ID |
| `USER#<id>` | `PROGRESS#<contentId>` | Learner progress |
| `USER#<id>` | `START#<requestId>` | Session start receipt |
| `USER#<id>` | `REVIEWREQ#<requestId>` | Review submission receipt |
| `CONTENT#<id>` | `VERSION#<version>` | Server-only published Challenge admission snapshot |
| `SESSION#<id>` | `STATE` | Private session record |
| `SESSION#<id>` | `RECORDING` | Recorder lease, saved cursors, and final recording state |
| `SESSION#<id>` | `CHUNK#<source>#<generation>#<sequence>` | One immutable object reference and its sequence range |
| `SESSION#<id>` | `EVENT#<epochMillis>#<source>#<n>` | Timeline event, time-ordered |
| `SESSION#<id>` | `TICKET#<sha256>` | Terminal ticket with a TTL |
| `SESSION#<id>` | `INPUT` | Input generation and owning connection, independent of recorder lease |
| `SESSION#<id>` | `REQUEST#<requestId>` | End and hint receipts |
| `SESSION#<id>` | `HINT#<hintId>` | Released hint and time |
| `SESSION#<id>` | `PROPOSAL#<proposalId>` | Assistant command proposal |
| `SESSION#<id>` | `TURN#<turnId>` | Challenge assistant turn |
| `SESSION#<id>` | `CONVERSATION` | Active turn ID and fixed expiry |
| `SESSION#<id>` | `FINALISED` | Marker that the finaliser has run |
| `SESSION#<id>` | `DEBRIEF` | Derived debrief and score components |
| `REVIEW#<id>` | `STATE` | Review submission and match result |
| `REVIEW#<id>` | `TURN#<turnId>` | Code Review assistant turn |
| `REVIEW#<id>` | `CONVERSATION` | Active turn ID and fixed expiry |

Event sort keys use the event time, a stable source stream ID, and its sequence number.
Reconnects preserve these IDs. API events use their request identity. The monitor assigns command
sequence numbers inside the task.

An owner index keyed by user and creation time lists sessions and submissions. A sparse
index holds unfinished lifecycle work, including provisioning and terminal sessions
awaiting cleanup, keyed by the next check time. The sweep handles startup deadlines,
missing schedules, heartbeats, and cleanup, even if the client never retries.
Indexes are eventually consistent. Coordinating writes use strongly consistent point
reads. Handlers return the committed record, so an index delay never hides a new session.
Active conversations also enter the work index by turn expiry. Expiry is an application
condition, not a DynamoDB TTL deletion. A delayed sweep cannot block a new request,
because admission also recovers an expired turn through a conditional write.

## Private S3 layout

| Key prefix | Contents | Writer |
| --- | --- | --- |
| `content/challenges/<id>/<version>/` | Manifest and debrief assets | Content publication |
| `content/reviews/<id>/<version>/` | Review bundle | Content publication |
| `content/learn/<id>/<version>/` | Rendered Pro Learn entry | Learn build step |
| `sessions/<sessionId>/terminal/<generation>/` | asciicast v2 chunks | Gateway |
| `sessions/<sessionId>/metrics/<generation>/` | Metric series chunks | Gateway |
| `sessions/<sessionId>/captures/<generation>/` | Per-command captures | Gateway |

Published content keys are immutable, with a hash in the catalogue manifest. The
frontend bucket holds only the static application and free Learn pages. Browsers read
session objects only through pre-signed links from the playback route. Terminal
recordings and log captures exceed DynamoDB's item size, which is why they live in S3.

## Conditional writes

| Operation | Write and condition |
| --- | --- |
| Start | Transaction: start receipt absent, active lock absent, session created in `provisioning` with a fixed deadline, schedule name, and launch arguments |
| Save task | Set ARN only if absent or equal to this ARN. A terminal session still records a late ARN for cleanup, never returns to `provisioning` |
| Ready | Update conditional on `provisioning`, time before its deadline, monitor health, and the current recorder acknowledgement. Save `readyAt` and `endsAt`. The task address is already saved for recorder attachment |
| Outcome | Transaction conditional on active status: outcome and `endedAt`, recording set to `draining` with a fixed cutoff and drain deadline. The first outcome wins |
| End | Transaction: the outcome update and the end receipt |
| Heartbeat | Update `lastSeenAt` conditional on `ready` |
| Ticket use | Delete conditional on existence and an unexpired `expiresAt`, returning the old item |
| Hint | Transaction: hint item absent, session hint count equal to the expected value, receipt |
| Input claim | Increment generation and set connection owner conditional on the previous generation and an active session. Terminal acknowledgement is required before browser readiness |
| Proposal dispatch | Change `pending` to `dispatching` with a fixed token, conditional on expiry, active session, and input owner |
| Proposal acknowledgement | Same token only. Record `accepted` after terminal acceptance, `pending` only after definite non-delivery, otherwise `unknown`. No automatic resend |
| Recorder claim | Claim an absent or expired lease and increment its generation. Renewal requires the same owner and generation |
| Recording append | Save cursors and object references only after upload, with the current unexpired lease and recording still open. Event identity makes retries idempotent |
| Seal recording | Conditional on `draining`. `complete` requires the current recorder lease, all final cursors saved without gaps, and time before the drain deadline. Otherwise use `incomplete` and a reason |
| Finalise | Transaction: `FINALISED` absent, recording sealed, task confirmed stopped, debrief written if ready was reached, progress updated, lock released only if it still names this session |
| Start turn | Transaction: turn ID absent and conversation slot absent. Store hash, worker token, fixed expiry, `running` turn, and active slot |
| Expire turn | Transaction: turn still `running`, expiry reached, slot still names the turn. Set `interrupted` and clear the slot |
| Finish turn | Transaction: `running`, matching worker token and active slot, before expiry. Save terminal result and allowed proposal, then clear the slot |

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

Recording chunks use the recorder generation and source sequence in their keys. Event
IDs preserve the original source and sequence across reconnects, so replaying a buffered
event does not append it twice. The final debrief uses the sealed set of references,
not a fresh scan of the S3 prefix. Terminal outcomes with incomplete recording store a
null score. They never substitute zero for missing counters.

## Bounds and retention

DynamoDB has a 400 KB item limit. Proposed application limits, to validate with the
first image:

| Item | Limit |
| --- | --- |
| Timeline event | 16 KB, with command text and output excerpt each capped at 4,000 characters |
| Commands per attempt | 5,000 |
| Capture | 256 KB, with at most 200 new lines per watched log |
| Terminal recording | 20 MB per attempt, after which recording stops and the learner is told |
| Terminal input | 64 KiB per second per session at the gateway |
| Chat input | 4,000 characters |
| Review flags | 50 per submission, 2,000 characters per concern |

Reject limits before side effects with a stable error.

Recordings contain everything the learner typed or printed, which may include secrets
they paste by mistake. The retention period is open and must be agreed before the
external pilot. S3 lifecycle rules then expire session objects. Deleting a learner
removes their table items, session prefixes, conversations, and submissions.

## Versioning

Published content is immutable. Changing a Challenge image, the monitor image, the
manifest, validators, traps, hints, or debrief text creates a new Challenge version with
its own task definition revision and digests. Existing sessions keep their pins.
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

The current start increment stores the exact ECS arguments, monitor secret, task ARN,
provisioning and launch-recovery deadlines, schedule name, and cleanup state. It creates
the expiry schedule before `RunTask`. Provisioning timeout cleanup releases the active
lock only after a saved task is stopped or the bounded launch-recovery period passes with
no active task. Readiness, lifecycle indexes, and the reconciliation sweep remain to be
implemented before the API is enabled.
