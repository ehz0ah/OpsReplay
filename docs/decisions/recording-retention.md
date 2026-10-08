# Recording retention and deletion

Status: implemented locally, AWS validation pending
Date: 8 October 2026
Owner: Evaluation owner

## Context

Recordings can contain terminal input, terminal output, and operational evidence. A
learner can paste private data by mistake. The retained recording bucket therefore must
not keep objects indefinitely.

The gateway uploads an immutable object before it publishes the object reference in
DynamoDB. This order prevents a durable reference from pointing to a missing object. A
failed conditional commit or recorder takeover can leave the uploaded object without an
authoritative reference.

## Decision

Every recording object carries the `opsreplay-retention` S3 object tag at creation:

| Recording class  | Tag value     | Expiry from object creation | Purpose                                                    |
| ---------------- | ------------- | --------------------------- | ---------------------------------------------------------- |
| Live page        | `provisional` | 7 days                      | Active recovery and incomplete recording diagnosis         |
| Sealed recording | `sealed`      | 30 days                     | Learner playback, debrief review, and formative evaluation |

All live pages use the provisional class, including pages with a committed DynamoDB
reference. The canonical sealed object contains the complete accepted monitor stream,
so live pages do not need long-term retention after sealing. An incomplete recording has
no sealed object and keeps its committed provisional pages for the same seven-day
diagnostic period.

The public session contract limits an active attempt to four hours. The shared drain
window adds at most one minute. Seven days therefore cannot expire a valid active
recording under the application contract. S3 expiration is asynchronous and is not a
session timer.

The sealed tag describes the object format, not authority. If a sealed upload succeeds
but its DynamoDB transaction fails, the unreferenced object still expires after 30 days.
Playback and scoring use only the sealed reference stored in DynamoDB. They never infer
authority from an object tag or an S3 prefix scan.

The authoritative `RECORDING` item has a nullable `retainUntil`. It is null while a
recording is active. A complete recording uses the fixed cutoff plus 30 days. An
incomplete recording uses its start time plus seven days, or its completion time when
recording never started. These anchors occur no later than object creation, so the
application boundary cannot outlive the corresponding S3 lifecycle period.

Every reader must load `RECORDING` before it follows sealed or chunk references. At or
after `retainUntil`, playback returns `410 RECORDING_EXPIRED` without reading S3. Before
that boundary, a missing referenced object is an integrity failure. Pre-signed links
must not remain valid after `retainUntil`. The debrief remains available after recording
expiry.

S3 Intelligent-Tiering is not enabled. It changes storage cost, not deletion or consent.
Live objects are also capped at 128 KiB, so automatic tiering would not address the main
provisional-object case.

## Consent and deletion

The evaluation owner must obtain informed consent before starting a recorded external
pilot session. The consent notice must state what is recorded, why it is recorded, the
two retention periods, and how to request deletion. A learner who does not consent
cannot start a Challenge because a tamper-resistant recording is part of the Challenge
contract.

The evaluation owner owns deletion requests. Refuse deletion while the session is active.
The session must be terminal, its recording must be `complete` or `incomplete`, its
recording-work entry must be retired, and no `USER#<ownerId>/ACTIVE` lock may name it.
Never alter an active lock that names another session.

Delete every object under `sessions/<sessionId>/` first so a failed operation remains
discoverable and can be retried. Then delete every item under `SESSION#<sessionId>` and
the matching `USER#<ownerId>/START#<requestId>` receipt whose value names the session.
The receipt is removed because it points to the deleted session and cannot be replayed
without that session record. Verify the S3 prefix, session partition, and receipt are all
absent before confirming deletion to the learner. The recording worker has no list,
delete, or existing-object retag permission. A separate operator-authorized deletion
action must implement this path before the external pilot.

## Validation

Local tests verify that live and sealed uploads carry the required tag, the bucket has
both lifecycle rules, the provisional period exceeds the maximum active recording
window, the gateway role can write only the two approved tag values, and an explicit
deny protects an existing object's retention tag. These tests do not prove managed S3
lifecycle timing or IAM enforcement. During the temporary AWS checkpoint, verify an
initial tagged upload succeeds and a standalone attempt to retag that object fails.
Also verify the lifecycle rules before enabling the recording path.
