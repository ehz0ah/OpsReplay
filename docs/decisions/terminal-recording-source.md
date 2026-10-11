# Bounded terminal recording source

Date: 11 October 2026. Status: implemented locally for the draft reference Challenge.
Requirement: PRD P08/P10 and the approved I01/I03 source increment. Issue #42.

## Context

The existing private server observes the original Bash PTY. Its interactive reconnect
buffer is only the last 64 KiB and has no durable cursor. Saving browser deliveries
would miss disconnected output and duplicate replay. The Gateway already has a browser
relay and a monitor recorder; neither records the original terminal stream.

## Decision

Add a separate `recording` connection mode to the existing TCP 7681 NDJSON endpoint.
Do not add a service, port, dependency, or learner credential. Preserve every existing
interactive v1 frame shape. The private network remains the access boundary.

One process-generated UUID identifies an append-only journal. Positive sequences
record initial 80 by 24 dimensions, successful resize/attach dimensions, successfully
written input prefixes, original output bytes, and final exit. Observation timestamps
use one wall-clock origin plus monotonic elapsed time. Base64 preserves bytes. This
is not command parsing, completion detection, or causal evidence.

The journal stores encoded events rather than mutable dictionaries. Reads visit at
most 100 events, pack by encoded bytes under 24 KiB including newline, and never
consume or acknowledge data. Requests use exact schemas, duplicate-key rejection,
a 1 KiB limit, source/cursor checks, and ten reads per second per connection. Existing
connection and timeout bounds remain shared with interactive access.

Retention is at most 20,000,000 encoded event bytes and 100,000 events for the entire
attempt, not just its unread backlog. Reserve 128 bytes and one event within these
limits for final exit. Normal data can use at most 19,999,872 bytes and 99,999 events.
The event cap bounds object overhead for tiny input or resize floods. On exhaustion,
preserve the data prefix and publish permanent `limit_exceeded` at the first omitted
observation. Stop recording input, output, and dimensions, even if a reader is current.
Do not block the PTY or silently evict history. Finalization still appends exactly one
exit with the next retained sequence and sets `exited` atomically. The exit reports the
shell result; it does not fill a gap or clear loss. This is temporary process memory,
not a durable recording or a promise about final export size.

A short journal lock covers a nonblocking PTY read/write or resize plus append. The
reader never takes the long input-operation lock. Select waits, replay, output-queue
waits, and socket sends occur outside the journal lock. Input can therefore wait for
PTY capacity while output still drains. Recording sends cannot hold shell ownership.

Bash exit changes metadata to `exiting` before tail collection and rejects new input.
Tail collection ends at the first empty nonblocking read after detected Bash exit,
including EAGAIN from a quiet background process retaining the PTY. That is a source
boundary, not evidence of a gap. Later background output is outside this recording and
is not claimed captured. The one-second deadline and 64 KiB bound still report
`data_gap` if reached, as do uncertain read or queue failures. Permanent loss freezes
normal data but cannot suppress final exit. Finalization sets `exited`
and permits only recording access for at most 60 seconds, consistent with the existing
post-session window. One zero-byte exit control event may follow the eight bounded
live output frames. SIGTERM/SIGINT bypass grace. Startup now requires running-shell
metadata, not just an open terminal port. The existing restart marker still refuses
a replacement shell when process-local state is lost.

## Limits and follow-up

### Lifetime budget and consequence

One large log print or an accidental `yes` can permanently stop normal terminal
recording for the attempt. Reading pages does not restore capacity. Relevant loss within
the saved session interval makes the future combined recording incomplete. Under P09,
that recording has a null numeric score, not zero, even if monitor data remains intact.
This PR neither implements scoring nor prevents deliberate scoring avoidance.

The caps are conservative resource limits aligned with the existing proposed 20 MB
per-attempt terminal export policy. They are not measured four-hour capacity. Over the
maximum 14,400-second session, the normal-data budget averages about 1,388.9 encoded
bytes per second and 6.94 events per second. JSON and base64 overhead reduce the raw-byte
budget. PTY read batching varies, so a log-line rate is not a fixed event rate. Sustained
arbitrary output can exhaust either cap well before four hours. Measure real workloads
before changing the limits or claiming adequate capacity.

### Conditional durable trimming

Trimming is not part of this source-only increment. Consider it when the Gateway
adapter has durable persistence, but do not treat a read or upload as acknowledgement.
A `durable through N` operation needs a saved committed cursor, current fenced recorder
authority, and the matching source UUID. It must reject future or uncommitted cursors
and preserve sequences independently of retained list indexes. Readers behind the
retained boundary need explicit stale-cursor rejection, not silent skipped data.
Trimming bounds the unsaved backlog only; increasing the lifetime export allowance
requires a separate policy decision. Do not promise trimming in the next adapter PR
without resolving these contracts.

Root can alter the source and its files. It is not tamper-proof. The future Gateway
adapter must independently validate wire data and persist it outside learner access.
Saved cursors advance only after storage commit. Source sealing is not implemented.
Future cutoff integration must observe a timestamp strictly beyond a millisecond
cutoff before excluding additional equal-timestamp events. Loss after cutoff is not
by itself proof of loss before cutoff.

Gateway persistence, source checkpoint migration, combined terminal/monitor completion,
readiness, shell markers, captures, scoring, UI playback, image publication, and AWS
changes are excluded. Current monitor-only `complete` cannot represent full playback.

## Validation

Private TypeScript validators and actual Python wire conformance cover exact shapes,
bytes, clocks, cursors, sequence order, and loss. Python fault injection covers retention,
page packing, partial writes, failed resize, and independent reader locking. Real image
checks cover disconnected output, two readers, saved-cursor reconnect, interactive
ownership, overflow with a usable shell, bounded exit/grace, termination, and restart
fencing. Existing Challenge repairs/traps and Gateway/monitor regressions remain
required. Local evidence does not prove Fargate, public transport, or capacity under load.

## Rollback

Revert this increment and rebuild the unpublished image. No data migration, deployed
resource, or published Challenge version is changed. Future consumers must not be
activated until their source contract and lifecycle integration have passed review.
