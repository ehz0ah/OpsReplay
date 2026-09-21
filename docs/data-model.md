# Data model

Status: proposed v0.1 persistence contract. The engine model and wire model are
separate. Public DTOs must use explicit allowlists.

## Domain records

| Record | Identity and contents | Visibility |
| --- | --- | --- |
| ContentVersion | Content ID, immutable version, engine version, hash, publication status, difficulty, access, provenance | Catalogue subset public |
| ScenarioDefinition | Variables, rules, evidence, checkpoints, terminal conditions, debrief | Server only |
| Session | Owner, pinned content/engine version, version counter, tick, status, state, costs, revealed evidence IDs, event flags | Public projection only |
| EventBatch | Session ID and commit version, ordered deterministic events and outputs, separate wall-clock audit metadata | Revealed event projection |
| RequestReceipt | Owner/resource scope, request ID, canonical payload hash, result or pointer, committed version | Owner only |
| Checkpoint | Parent session, checkpoint ID, full immutable state and prefix position | Metadata only before replay |
| ReplaySession | Normal Session plus parent/checkpoint reference and informed-practice flag | Owner only |
| ConversationTurn | Session, turn ID, input version, status, messages, selected operations, usage, outputs | Owner, visible content only |
| ActionProposal | Session, proposal ID, expected version, canonical command, expiry, consumption status | Owner only |
| AccessGrant | Owner, library scope, active state, optional expiry | Server only |
| ReviewSubmission | Owner, exercise/version, marked lines, concerns, submitted status, released authored findings | Owner only |
| Progress | Owner, content ID, completed first attempts, last attempt, assistance flag | Owner only |

Code Review stores text for reflection. Do not infer a numerical correctness score
from arbitrary free text. Prepared findings are released after submission.
Learn entries and catalogue reads do not create game sessions.

## Proposed DynamoDB keys

One table is sufficient initially. Avoid scans for normal user requests. Item
names are a working storage convention, not part of the public HTTP contract.

| PK | SK | Contents / access |
| --- | --- | --- |
| `USER#<id>` | `PROFILE` | Minimal account preferences |
| `USER#<id>` | `GRANT#<scope>` | Active practice entitlement |
| `USER#<id>` | `PROGRESS#<contentId>` | Learner progress |
| `USER#<id>` | `START#<requestId>` | Session/review creation receipt |
| `SESSION#<id>` | `STATE` | Current private snapshot, owner, content pins |
| `SESSION#<id>` | `OBSERVATION#<evidenceId>` | Latest bounded observation with its original identity |
| `SESSION#<id>` | `EVENT#<zero-padded-version>` | One bounded event batch per accepted command |
| `SESSION#<id>` | `REQUEST#<requestId>` | Persistent idempotency receipt |
| `SESSION#<id>` | `CHECKPOINT#<checkpointId>` | Immutable checkpoint |
| `SESSION#<id>` | `TURN#<turnId>` | Bounded conversation metadata/output pointer |
| `SESSION#<id>` | `PROPOSAL#<proposalId>` | Single-use confirmed-command proposal |
| `REVIEW#<id>` | `STATE` | Review submission and released findings |
| `REVIEW#<id>` | `REQUEST#<requestId>` | Submission receipt |

Use a user/status index for listing owned sessions and reviews, with creation time
as sort key. Indexes are eventually consistent. Point reads of current state and
request receipts must be strongly consistent when coordinating writes. The API
returns the committed projection so an index delay does not hide a new session.

Published content lives under immutable private S3 keys. Store a hash in the
catalogue manifest. A public catalogue projection excludes solution assets,
resolution rules, and internal content filenames. Content discovery does not list
the private bucket directly.

## Atomic action commit

The repository port accepts `expectedVersion`, `nextState`, `eventBatch`, receipt,
optional checkpoint, and optional proposal consumption. One transaction must:

1. Update state only when owner and current version match the expected values.
2. Insert the event batch and request receipt only if absent.
3. Insert an eligible checkpoint only if absent.
4. Consume a confirmed proposal only if its owner, version, command, and expiry match.
5. Update latest-observation records while retaining immutable payloads in the
   event batch. Reject writes that exceed bounded transaction limits.

All or none commit. A failed transaction cannot leave the state ahead of history.
Application receipts, not DynamoDB's ten-minute client-token deduplication, enforce
idempotency for the life of a session. Canonical request hashing includes command,
expected version, source, and proposal ID but excludes transport timestamps.

A retry checks ownership, then the receipt, before rejecting an old expected
version. Same ID/same hash returns the saved result. Same ID/different hash returns
`IDEMPOTENCY_CONFLICT`. Distinct requests with the same expected version race, and
only one can commit. Never replay a losing mitigation automatically.

Store a compact action result in the receipt, with a pointer to immutable event
output if needed. A retry returns that saved result and the current owned public
session projection. This avoids storing a full session projection per command.
Output observations identify the original execution version, while the session
field may be newer. The client must not roll back its displayed state.

Start/replay operations use owner-scoped receipts so a retry cannot create two
sessions. A replay transaction verifies terminal parent state and an immutable
checkpoint. Ending a session is idempotent and advances version, not incident time.
Session creation, first checkpoint, initial event, and owner-scoped receipt commit
together. Review creation uses the same owner-scoped receipt discipline.

## Bounds and retention

DynamoDB has a 400 KB item limit. Store ordered history and evidence snapshots as
separate bounded items, not an ever-growing session array. Proposed application
limits are 256 KB per item, 500 commands per attempt, 10 ticks per explicit advance,
100 events per command, and 4,000 characters per chat/concern input. Reject limits
before mutation with a stable error. These values require load/content validation.

Keep checkpoints bounded, including referenced samples rather than copying large
histories. Large scenario artefacts remain in S3. Cap provider conversation context
without discarding committed action history from the application.

Do not expire receipts earlier than their session. Deletion removes session state,
events, receipts, checkpoints, conversation, and replay descendants consistently.
Retention and pilot consent must be decided before collecting external data.

## Versioning

Published scenario versions are immutable. Changing constants, actions, evidence,
or debrief creates a new content version. Semantic changes to rule evaluation
create a new engine version. Existing sessions keep both pins. A migration must
not silently reinterpret old actions. The public API starts at `/v1`.

## Repository ports

Implement `createSession`, `getOwnedSession`, `commitAction`, `getReceipt`,
`listEvents`, `createReplay`, `getContentVersion`, and `getAccessGrant` before LLM
or UI integration. Local and DynamoDB adapters share concurrency and duplicate
request tests. Add conversation and review ports when those work packages start.
