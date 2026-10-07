# Gateway monitor recording increment

Date: 7 October 2026. Scope: the bounded gateway controller that records one monitor
stream through an injected sink. Recorder leases, DynamoDB checkpoints, S3 chunks, the
running gateway service, browser relay, terminal access, and AWS deployment remain
separate.

## Choices

Use the existing `MonitorClient` for transport. The recorder uses the monitor's
idempotent start operation and rejects a start time that differs from its saved
checkpoint. A replacement then resumes from its source and cursor without creating a
second measurement stream. A replacement that only completes an already sealed outcome
can call seal directly from its saved checkpoint.

Send each non-empty page to the recording sink before advancing the in-process cursor.
The sink is scoped to one session and must make `begin`, `append`, and `seal` durable and
idempotent before returning. An append identifies its expected prior cursor and exact
source and sequence range. A failed or uncertain append does not advance the recorder,
so a replacement can safely repeat that range.

Polling stops through caller cancellation. Cancellation of a monitor read or polling
delay is a normal stop, while transport, validation, and sink failures remain visible to
the gateway supervisor. The controller does not own its monitor client and does not hide
failures with unbounded retries.

Frames read before the gateway learns the session outcome are provisional. After the
caller stops polling, the recorder sends the exact lifecycle cutoff to the monitor. It
then reads the sealed stream again from sequence zero and asks the sink to replace the
provisional view. This excludes frames after the cutoff and allows the saved final
references to become the source for scoring and playback. The final metric sample must
use the same cutoff. The canonical stream can be empty even when provisional frames were
committed. Such a stream has a null source and a zero cursor.

Reading from sequence zero keeps canonical filtering in the monitor and does not require
the sink to interpret provisional frames. Sealed reads remain paced because they use the
same authenticated request limit as live reads. Tail-only reconciliation is deferred
until a durable sink can trim provisional data atomically and return the final cursor,
and measurements show that the added contract is necessary.

Cap one monitor stream at 10,000 frames. This matches the current monitor buffer and
bounds final reconciliation in memory. A larger published limit needs a new storage and
reconciliation design before it is accepted.

## Validation boundary

Unit tests cover page commit ordering, failed appends, restart from a checkpoint,
cancellation, frame bounds, exact cutoff reconciliation, malformed sealed streams, and
retry after an uncertain final commit. The container test runs the bundled recorder
against the real monitor and Challenge images, interrupts it after a committed page,
resumes from that checkpoint, and seals the complete stream.

The local sink used by the container test is not production persistence. These checks do
not prove recorder lease enforcement, DynamoDB conditional writes, S3 uploads, browser
delivery, Fargate networking, or AWS recovery.
