# Gateway recording supervision increment

Status: implemented locally, AWS validation pending
Date: 8 October 2026
Owner: Hao Zhe

## Context

The lifecycle now publishes recordable sessions, and the gateway can run one durable
recording. A production gateway still needs a controlled way to discover many sessions
without trusting an eventually consistent index or allowing one recording to block all
other sessions.

## Decision

Use the `unfinished-work` DynamoDB global secondary index only as a discovery hint. The
work source parses each keys-only result, skips sessions already supervised by the local
process, and then strongly reads the base session. It returns the private task address,
public monitor certificate, and secret only after it validates the authoritative session
state and certificate. Terminal work is retired only while the exact work key and the
terminal session state remain unchanged. The lifecycle expiry action, not the gateway,
owns the terminal transition for overdue provisioning sessions.

Run a bounded number of `MonitorRecordingRunner` instances in one supervisor. One
session can have only one active runner in that process. A bounded cooldown delays lease
contention and recoverable failures. The discovery cursor lets other sessions progress.
Malformed entries are skipped and reported without blocking valid work from the same
query. Monitor, storage, and transient AWS failures are reported and isolated. Invalid
configuration, permission failures, and programming errors cancel all active runners
and stop the supervisor. Shutdown also cancels and awaits every active runner, which
closes its monitor client.

The concrete composition uses one shared DynamoDB document client and one shared S3
client. Their connection timeouts, request timeouts, and retry counts are bounded. This
increment does not add an executable gateway process, AWS resources, IAM, or service
deployment. Those belong to the next stacked change.

## Failure and recovery

The DynamoDB lease remains the cross-process ownership boundary. Two gateway copies can
discover the same session, but only one generation can claim it. A replacement resumes
from the durable cursor after lease expiry. Completed and non-recordable sessions remove
their work entry. An uncertain removal response is accepted only after a strong read
proves that the exact entry is absent or changed.

Cooldown tracking is capped at the configured local concurrency. The source accepts a
bounded exclusion set for active and cooling sessions. If more distinct sessions fail
within one cooldown window, the supervisor pauses all discovery for one retry interval.
This prevents unbounded process memory, invalid discovery requests, and immediate retry
loops.

## Validation

Unit tests cover concurrent runners, local duplicate suppression, contention retries,
bounded cooldown state, operational failure isolation, fatal-error propagation,
cancellation, work validation, pagination, retirement, uncertain responses, and request
bounds. A DynamoDB Local test proves the keys-only GSI query and conditional removal
expressions against a real DynamoDB-compatible implementation.

The full gateway suite, image test, and repository checks must pass before publication.
These tests do not prove IAM, EventBridge delivery, ECS service behavior, private VPC
connectivity, or managed DynamoDB and S3 behavior. The next change must validate those
parts in AWS.
