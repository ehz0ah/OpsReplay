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

S3 Intelligent-Tiering is not enabled. It changes storage cost, not deletion or consent.
Live objects are also capped at 128 KiB, so automatic tiering would not address the main
provisional-object case.

## Consent and deletion

The evaluation owner must obtain informed consent before starting a recorded external
pilot session. The consent notice must state what is recorded, why it is recorded, the
two retention periods, and how to request deletion. A learner who does not consent
cannot start a Challenge because a tamper-resistant recording is part of the Challenge
contract.

The evaluation owner owns deletion requests. Deleting one session removes every object
under `sessions/<sessionId>/` and every DynamoDB item under `SESSION#<sessionId>`. Delete
S3 objects first so a failed operation remains discoverable and can be retried. Confirm
that both locations are empty before confirming deletion to the learner. The recording
worker has no list or delete permission. A separate operator-authorized deletion action
must implement this path before the external pilot.

## Validation

Local tests verify that live and sealed uploads carry the required tag, the bucket has
both lifecycle rules, the provisional period exceeds the maximum active recording
window, and the gateway role can write only the two approved tag values. These tests do
not prove managed S3 lifecycle timing or IAM enforcement. Verify both during the
temporary AWS checkpoint before enabling the recording path.
