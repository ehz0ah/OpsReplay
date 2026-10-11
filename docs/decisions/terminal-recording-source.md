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

Retention is at most 20,000,000 encoded event bytes and 100,000 events. The event cap
bounds object overhead for tiny input or resize floods. On exhaustion, preserve the
prefix, freeze appends, and publish permanent `limit_exceeded` with the first omitted
time. Do not block the PTY or silently evict history. This is temporary process memory,
not a durable recording or a promise about final export size.

A short journal lock covers a nonblocking PTY read/write or resize plus append. The
reader never takes the long input-operation lock. Select waits, replay, output-queue
waits, and socket sends occur outside the journal lock. Input can therefore wait for
PTY capacity while output still drains. Recording sends cannot hold shell ownership.

Bash exit changes metadata to `exiting` before tail collection and rejects new input.
Tail collection has a one-second deadline after detected exit and a 64 KiB bound.
A retained/flooding PTY or uncertain tail reports `data_gap`. Finalization sets `exited`
and permits only recording access for at most 60 seconds, consistent with the existing
post-session window. One zero-byte exit control event may follow the eight bounded
live output frames. SIGTERM/SIGINT bypass grace. Startup now requires running-shell
metadata, not just an open terminal port. The existing restart marker still refuses
a replacement shell when process-local state is lost.

## Limits and follow-up

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
