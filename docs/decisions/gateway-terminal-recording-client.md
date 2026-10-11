# Gateway terminal recording client

Date: 11 October 2026. Status: implemented locally. Requirement: PRD P08/P10,
I03. Issue #44.

## Context

The Challenge has a bounded terminal journal on its existing private TCP endpoint.
The interactive client cannot export it: browser replay is truncated, can repeat
bytes, and excludes disconnected output. The Gateway monitor recorder saves
measurements and recovery/outage events, not terminal bytes or application logs.

## Decision

Add `TerminalRecordingClient` to the existing Gateway code package. It attaches in
`recording` mode on TCP 7681 and exposes `read(after)`, `close()`, and `ended`.
It does not acquire interactive ownership. The caller supplies an authoritative
IP and may pin the expected source UUID when reconnecting.

Each read supplies its own cursor. Reads are nondestructive. No internal durable
cursor, polling, retry, reconnect, or background worker is added. One operation is
allowed at a time; concurrent reads reject `busy` rather than enter a queue.
Invalid input and pre-send cancellation leave the connection usable. In-flight
cancellation, timeout, source rejection, malformed data, or transport loss close it,
so a late response cannot be assigned to another operation.

The client checks the actual 24 KiB NDJSON limit including newline, fatal UTF-8,
JSON syntax, duplicate decoded keys, and a nesting limit of eight. It uses the
existing private schema validators for exact frames, canonical byte payloads,
page size, clocks, source identity, contiguous sequences, and exit/loss rules.
Extra or unsolicited bytes fail closed. Diagnostics contain only fixed messages
and allowlisted source codes, not remote payloads, addresses, or arbitrary causes.

Within one connection, source identity and start time are stable. Observation time,
latest sequence, and shell phase cannot move backwards. Newly observed events or
loss cannot predate an earlier snapshot, but equal millisecond timestamps are valid.
First loss is permanent and permits only the reserved final exit sequence. Exited
metadata cannot resume or acquire new loss. Returned data does not alias validation
state. One copied frontier event checks replay identity at that boundary and
relative event clocks. The last nonempty page's end also checks adjacent replay
pages below the frontier. Full history is not cached or authenticated.

## Limits and follow-up

This is an internal read client, not an activated terminal recorder or a new service.
The composed Gateway still runs the monitor-only recorder. Receiving `nextSequence`
is not a storage commit. Source `exited`, no loss, or reaching `latestSequence` does
not prove combined recording completion. Root controls the source, so successful
validation does not prove authenticity or complete capture.

Future persistence must validate saved source metadata, commit immutable terminal
chunks before advancing a saved cursor, fence recorder authority, and apply the
saved lifecycle cutoff. Terminal and monitor final cursors must both be reconciled
before full playback is complete. Current monitor-only `complete` is unchanged.
Source trimming, checkpoint migration, workers, lifecycle readiness/completion,
shell markers, captures, scoring, playback, and AWS deployment are excluded.

## Validation

Real local TCP tests cover valid pages, replay, byte limits, malformed and duplicate
JSON, clock and metadata continuity, cancellation, deadlines, concurrency, transport
failure, and fixed errors. Separate restricted Node containers test the bundled
client against the real Python source and Bash PTY. They cover two readers,
interactive generation replacement, disconnected output, same-source reconnect,
quiet post-exit tail, overflow, frozen data, and preserved exit code 7.
Existing Challenge, monitor, Gateway, and runtime-image regressions remain required.
Local checks do not prove Fargate, public transport, managed storage, or capacity.

## Rollback

Revert this increment. It changes no public contract, source protocol, saved data,
AWS resource, runtime configuration, or published image. No migration is needed.
