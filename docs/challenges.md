# Challenge environments

Status: proposed v0.2 runtime contract, following the preliminary report. It replaces the
earlier simulated engine. The three [Challenge manifests](../content/challenges/README.md)
are drafts. A [local reference image](../content/challenges/wrong-upstream-port/README.md)
implements the wrong-upstream-port service stack and image tests. The
[monitor](../apps/monitor/README.md) implements local traffic, recovery, outage checks,
and authenticated HTTPS control. A gateway controller can record, resume, and seal this
monitor stream through an injected sink. The reference image has a private interactive
terminal and a bounded read-only recording source. The gateway has a locally tested
interactive and recording clients, admission, browser relay, composed process, and monitor storage
adapters. Durable terminal pages, combined cutoff sealing, lifecycle cleanup,
bounded command evidence, interval captures, and atomic debrief finalisation are
implemented and tested locally. Playback exports/read APIs, environment task
publication, and the complete public AWS path remain unimplemented or unvalidated. Numbers
marked proposed are starting values to measure, not results. The full task and publication
requirements below remain unproven.

## Principle

Each Challenge runs real services with one planted misconfiguration. Learners investigate
with ordinary tools and repair real files. There is no fixed action list. Any valid fix
restores service, and mistakes have real effects. Consequences come from system
behaviour, not from authored rules. Automated validators decide recovery.

Time is wall-clock time. Traffic continues while the learner reads logs, waits for the
assistant, or leaves the tab, so failed requests accumulate while the fault remains.

## Environment task

Starting a Challenge runs one Fargate task with two containers:

| Container   | Contents                                                                                                                                                  | Learner access  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `challenge` | The Challenge image: the service stack under a process supervisor, and a terminal server that gives the learner a root shell                              | Full root shell |
| `monitor`   | The shared monitor image, configured by the manifest: traffic generator, metrics, validators, health probes, captures, and a control port for the gateway | None            |

The containers share the task's network namespace, so the monitor reaches services over
localhost. Watched configuration and log paths are shared with the monitor read-only
through a task-local ephemeral volume at `/opsreplay/watched`. The
[publication helper](../infra/environment-watched-volume.ts) defines the Challenge
writable mount, Monitor read-only mount, and Challenge-only initialisation option.
Local Docker tests use this layout. No environment task definition is deployed or
created by the current application stack. Its publication and Fargate isolation
check remain prerequisites for activation. No Monitor secret enters the volume. A separate
container protects the monitor's files and processes only when its storage and PID
namespace are private. Shared networking still needs the controls below. Learners can
alter the service responses and files being measured, but not the saved recording.

The challenge container is essential. The monitor verifies the initial incident state
before the session becomes ready. Initial listener checks are for startup only. Do not
use learner-controlled service ports as Docker or ECS liveness checks. After readiness,
a stopped service is part of the incident, not a reason to end the container. Images
provide `service <name> start|stop|restart|reload` wrappers over the supervisor so familiar
commands work.

Task settings:

- CPU and memory come from the manifest. The time limit also caps cost.
- No task IAM role, so a root shell exposes no AWS credentials. The execution role only
  pulls images and delivers monitor logs. ECS Exec stays disabled.
- Private subnets with no internet route. The security group accepts inbound traffic only
  from the gateway service, on the terminal and monitor ports. Egress reaches only the VPC
  endpoints needed for image pulls and monitor logs.
- Images are pinned by digest in the task definition revision for each Challenge version.
- Fargate disallows privileged containers, so there is no nested Docker. It allows adding
  only the `SYS_PTRACE` capability. See the [Fargate references](references.md).
- Do not add `SYS_PTRACE` or `NET_ADMIN`. Drop `NET_RAW` and every default capability
  the image does not need. Record the tested capability set with each image. Keep the
  monitor's root filesystem read-only, with a private bounded buffer volume. Reserve
  monitor CPU and memory so challenge load cannot silently stop measurement.

The same two images run under local Docker for development and scenario tests, with a
shared network namespace and volume.

## Private terminal server

The reference Challenge image listens on private TCP port 7681 and owns one root Bash
PTY. The endpoint is not an authentication boundary. The gateway must authenticate
the learner, authorize the session, and consume a terminal ticket before it connects.
The task security group must accept this port only from the gateway.

The private protocol is newline-delimited JSON. Each frame is at most 24 KiB. The first
interactive frame must be an `attach` frame with protocol version 1, mode `interactive`, a positive
input generation, and terminal dimensions from 1 to 500. A successful attach returns
`ready`. Input and output bytes use base64. Decoded input is at most 16 KiB. `resize` and
`heartbeat` use the installed generation. Complete PTY writes return `input_accepted`.
A partial write or timeout returns `INPUT_UNCERTAIN`; callers must not automatically
retry it.

The server serializes generation installation with input and resize operations. A larger
generation replaces the active connection. The old connection receives `REPLACED` when
its socket can accept the error immediately, then closes. It rejects an older attach or
operation with `STALE_GENERATION`. The shell stays alive across ordinary connection loss.
The server queues at most eight output frames and 64 KiB before it stops PTY reads. A
client that cannot accept one frame within one second is detached. While no client is
attached, the server keeps the latest 64 KiB of output. The next `ready` frame reports
`replayTruncated: true` if older bytes were dropped or a stalled send made delivery
uncertain. Replacing a live connection also reports uncertain continuity because output
frames have no acknowledgement. This replay buffer has no durable sequence cursor and is
not the terminal recording stream.

The gateway's private terminal client validates this protocol, serializes operations,
and applies output backpressure. It does not retry an input whose acknowledgement is
lost. The caller must supply a generation that Gateway admission claims from
authoritative session state. The Gateway admission and browser relay provide that layer.

At most eight clients can wait or attach. An unattached client has five seconds to send
its first frame. An attached client has a 45-second idle limit. Terminal bytes are not
written to process logs. The server does not restart inside the same container. A marker
under `/run/opsreplay-terminal` prevents a process or container restart from silently
opening a new shell after the in-memory generation fence is lost. The lifecycle must
treat that loss as an environment error. A new task starts with a new container and a
new marker. Bash ignores up to ten consecutive Ctrl-D inputs at an empty prompt. An
explicit `exit` terminates the terminal. The server watches the Bash process directly,
so a background process that keeps the PTY open cannot hide that exit.
After Bash exits, the active handler stops processing new operations while queued tail
output and the final `exit` frame are delivered. New interactive attachments remain rejected.
Read-only recording access remains available for at most 60 seconds after source
finalization. Tail collection is bounded by one second after detected Bash exit and
64 KiB. The first empty nonblocking read after Bash exit ends the source tail. A quiet
background process retaining the PTY alone does not cause loss. Later background output
is outside this recording. Reaching a tail bound or an uncertain read/queue failure
reports `data_gap`; final exit is still recorded. SIGTERM and SIGINT do not wait for this grace period.
The startup probe requests recording metadata and requires `shellState: running`.

## Lifecycle

```mermaid
stateDiagram-v2
  [*] --> provisioning: POST /v1/sessions
  provisioning --> ready: monitor healthy and recorder attached
  provisioning --> error: deadline passed or capacity rejected
  ready --> resolved: all validators sustained
  ready --> failed: time limit or challenge container exited
  ready --> ended: learner ended
  ready --> abandoned: heartbeat missed
  ready --> error: platform stopped the task
```

1. **Provisioning.** The monitor verifies the initial state: aggregate recovery fails
   (at least one validator fails) and every health probe passes. These checks are not
   learner measurements. Only then does its health check pass.
   A failed verification is an image defect. The session ends as `error` with
   `start_failed` and is logged for authors. One lifecycle routine owns launch,
   readiness, schedules, and cleanup. API calls, session stream events, ECS events,
   and the sweep invoke it from saved state. It repairs interrupted starts without a
   browser retry. See the [start contract](api.md#start).
2. **Ready.** The lifecycle handler saves the healthy task's address. A gateway claims
   recording ownership and acknowledges its initial terminal and monitor cursors before
   measurement starts. The measurement origin is committed as `readyAt`, so start-up
   latency is not charged to the learner. The alert is shown.
3. **Outcome.** The first outcome wins through a conditional write:
   - `resolved` when every validator has passed continuously for its sustain period;
   - `failed` with `time_limit` when the EventBridge Scheduler job fires;
   - `failed` with `environment_exited` when the challenge container exits, for example
     after the learner kills its supervisor;
   - `ended` with `learner_ended`;
   - `abandoned` with `heartbeat_missed` when `lastSeenAt` is older than five minutes
     (proposed), found by a sweep that runs every minute;
   - `error` with `environment_exited` when the platform stops the task for another
     reason.
     A lost or unhealthy monitor ends the attempt as a platform `error`, not recovery or
     zero impact. Recording becomes incomplete if its final samples cannot be recovered.
4. **Drain.** The outcome write also fixes `endedAt`, sets recording to `draining`, and
   sets `drainDeadlineAt`, proposed at 30 seconds later and always within the shared
   one-minute post-session window. These values never move on a retry. Input closes when
   the gateway observes the outcome. Activity after `endedAt` is excluded from scoring,
   even if a command was still running. The gateway asks the monitor to seal measurements
   at that cutoff and uploads the remaining terminal, metric, event, and capture data. It
   acknowledges `complete` only after the saved objects and events cover the final
   cursors with no gaps. A limit or unrecoverable gap produces `incomplete` with a reason.
   Neither state changes the session outcome.
5. **Finalisation.** The session stream and sweep call the same finaliser. It waits for
   recording completion before `StopTask`. If the recorder or task is lost, or the drain
   deadline expires, it seals the saved data as `incomplete` and stops the task. It never
   waits indefinitely for an acknowledgement. Once the task is confirmed stopped, it
   deletes the schedule and commits the debrief, progress, and finalisation marker once.
   Lock release is conditional on the lock still naming this session. A session that
   never became ready has no debrief. Reconciliation retries each unfinished step and
   discovers late tasks through ECS events and session tags, including pending tasks.
   It follows the drain rule before stopping a task with an outcome.

The drain deadline bounds the wait for recording, not AWS service recovery. Stop failures
remain pending for reconciliation and raise an alarm. The active-session lock remains
until cleanup is confirmed. Lambda never contacts the monitor. Gateway acknowledgements
and finalisation requests pass through stored session state.

An attempt labelled `first` is the learner's first attempt of that Challenge ID that did
not end in `error`. Environment faults never use up the first attempt.

## Monitor

**Traffic.** The monitor runs each manifest journey at its rate. A journey stops at its
first failed step. A step fails on an unexpected status, a connection error, or a
timeout. Every step counts toward `totalRequests`, and failed steps toward
`failedRequests`, from `readyAt` to the outcome. Request completion timestamps define
the cutoff. The monitor retains enough timestamped data to seal counters at `endedAt`
even when the gateway learns of the outcome later.

**Dashboard.** Request rate, error rate, and latency percentiles come from the monitor's
own traffic. CPU and memory for the challenge container come from the task metadata
endpoint's `/task/stats` path on Fargate, or from container statistics locally. Samples
are taken every five seconds (proposed).

The first monitor increment uses five-second samples. Rate, errors, and exact nearest-rank
p95 use ordinary requests completed in the preceding five seconds. Empty windows omit
error rate and latency. CPU and memory are omitted until the runtime adapter exists.
See the [measurement definitions](../apps/monitor/README.md#measurements). These partial
samples do not claim complete dashboard or recording support.

**Validators.** Each validator is evaluated every second (proposed). The aggregate
recovery state is `sustaining` while all pass, and `met` when each has passed
continuously for its own sustain period. Any failure resets the state to `failing` and
emits `recovery_lost`. The learner sees only the aggregate state.

HTTP status checks prove availability only. The `checkout` check also proves a minimum
business operation. For each run, generate a fresh reference, POST
`{"reference":"<reference>"}` to `/api/checkout`, require 201 with a JSON object whose
`id` is a non-empty identifier, `reference` matches, and `status` is `confirmed`, then
GET `/api/orders/<id>`. Require 200 and the same three fields. IDs use 1 to 128 ASCII
letters, digits, underscores, or hyphens. Both requests use the authored loopback
`baseUrl`, no redirects, a per-request timeout, and a 64 KiB response limit. Invalid JSON,
missing fields, a stale reference, or a failed read fails the check. This fixed check is
not a general assertion language and does not prove resistance to a deliberately forged
service. Image tests must verify the stored order and bound the test data volume.
Ordinary traffic may omit `reference`, in which case the image generates one. Validator
requests supply their own fresh reference so an old response cannot satisfy a new run.

Run each validator without overlap. A failed evaluation resets its passing window. A
missed scheduler slot resets the window only when no evaluation is already running. A
slow in-flight evaluation remains authoritative, then its completed result advances or
resets the window. Validator and probe requests are separate from the journey counters.
The three draft Challenges require both their journey and the checkout check, so the
slow order-history path is still tested where applicable.

**Health probes.** Probes pass at the start. A probe that fails continuously for its
grace period starts an outage. The outage event's time is the first failed check. The
outage ends when the probe passes again. Each probe has a public label that names the
symptom without revealing the cause.

**Captures.** After each command the recorder asks the monitor for a capture using a
stable command event ID. The monitor assigns a sequence on first receipt and replays it
for duplicate requests. It records changed watched files as bounded before/after
blocks, new log lines, and a timestamped metric sample. A renderer can display the
blocks as a diff. After measurement seal, the sample uses the fixed cutoff. Each capture includes `baselineAt` (the prior capture's start,
or the initial baseline's start), `startedAt`, and `completedAt`. These times and
`commandSeq` appear in the saved object and playback manifest. The gateway stores the
object in S3.

Reads are not an atomic filesystem snapshot. A later command or background process can
change a file before it is read. `commandSeq` identifies the capture request, not the
cause of every change. Show the interval and do not label a diff as changes made by that
command. The interval begins at the prior read start because files can change while a
capture is in progress. Serialize captures, not shell input. Establish the initial
watched-file baseline before readiness. Byte, line, and aggregate excerpt bounds,
or log rotation/truncation, mark the capture interval `incomplete` without making
the whole recording unscorable. The next log interval starts at the observed file
end, so omitted backlog is not attributed to a later request. Missing, unsafe,
unreadable, invalid-UTF8, or expired reads and missing metrics set `unavailable`.
This also sets `incomplete` and prevents complete recording. Both summaries remain
sticky in saved capture state.
Final drain paginates the sealed commands and requests one capture for a command
still open at cutoff. Captures can complete after cutoff and retain their full
interval. They are not atomic or exact-cutoff snapshots and do not enter score
calculations or observed-evidence matching. A missing required capture or an
unavailable evidence summary prevents complete recording.

**Control port.** Because the learner's shell shares the network namespace, it can reach
the monitor's port. Use TLS with the monitor's task identity verified by the gateway and
a per-session secret for gateway authentication. The working default is a per-task
certificate pinned in the private session record. Its key and the secret go only to the
monitor, never to the challenge container, a shared volume, or logs. The gateway must
verify the certificate before sending the secret. Plaintext control connections fail
closed. Bound request sizes and rates, including unauthenticated requests. Authenticate
gateway readiness checks so invalid traffic cannot consume their rate allowance. The
control port never returns validator or probe
definitions. The monitor keeps the session's samples, signals, and captures locally,
bounded, and serves them from a sequence number, so a reconnecting gateway can fetch
anything it missed.

The current local runtime listens on port 9443 with TLS 1.3. `GET /healthz` returns only
`starting`, `ready`, or `failed`. It and all control operations require the session secret.
The operations start measurement, read at most 100 public frames after a sequence cursor,
and seal at the immutable lifecycle cutoff. A retry with the same start or cutoff is safe.
A different cutoff is rejected. The monitor reserves an accepted cutoff before any wait,
so later reads cannot return records beyond it. Frames already relayed before the gateway
learns the outcome remain provisional. The gateway must discard records after `endedAt`
and replace the live view with sealed data. The monitor can wait briefly for its monotonic
clock to reach the supplied cutoff, but it does not alter that timestamp.

The root learner can still disrupt its own task network and prevent a later gateway
reconnection. Connection limits are resource bounds, not an availability boundary. A lost
monitor makes the recording incomplete and the attempt a platform error with no score.
Stronger denial-of-service isolation requires a separate network trust boundary. The
certificate delivery and task-address publication path is implemented locally but is
not deployed. The monitor recording supervisor is tested locally.

**Untrusted files.** Watched files are written by a root learner. The monitor reads only
regular files, never follows symbolic links, and caps the bytes it reads. Otherwise a
link could make it capture its own secret or another file from the monitor container.

## Command recording

The gateway records terminal input and output as timestamped asciicast v2 chunks outside
the learner's reach. Playback shows output. Input supports command reconstruction.

The complete recording design belongs to the session, not the browser connection. One gateway holds a
renewable recorder lease, proposed at 15 seconds with renewal every five seconds. It
keeps reading the terminal and monitor after the browser disconnects. Gateway workers
discover unclaimed or expired leases through the session work index. A replacement
increments the recorder generation and resumes from saved cursors. The reference
terminal now exposes the independent source described below. A read-only Gateway client
validates and reads it locally. Durable pages and the combined worker apply the
saved cutoff and condition both streams before completion. Live and sealed command
parsers commit with their terminal pages under the same recorder lease. The recorder
creates command events and requests captures. A browser may
connect through another gateway copy, which proxies input and output without recording
replay again.

### Bounded terminal source

On the same private TCP 7681 endpoint, a separate connection sends
`{"type":"attach","version":1,"mode":"recording"}`. It receives `recording_ready`
metadata and then uses `{"type":"read","source":"<source UUID>","after":0}`.
See the [private typed contract](../packages/contracts/private/terminal-recording.ts)
and [source decision](decisions/terminal-recording-source.md).

One source UUID lasts for the process/attempt, independent of input and recorder
generations. The journal records initial 80 by 24 dimensions, successful attach/resize
dimensions, successfully written input prefixes, original PTY output, and final shell
exit. Bytes are canonical base64. Sequences are contiguous. Replay delivery creates
no new event. Input observation is not proof of a completed command. UTC millisecond
timestamps use a fixed wall origin plus monotonic elapsed time.

Reads are nondestructive and do not change the shell, generation, replay, or learner
activity. Each page has at most 100 events and 24 KiB including its newline. Requests
have a 1 KiB limit and ten reads per second per connection. Both modes share the
eight-connection cap and existing attach, idle, and send deadlines. Metadata gives
source/start, dimensions, latest sequence, observation time, `running`, `exiting`, or
`exited` shell state, and permanent loss reason/time.

The source retains at most 20,000,000 encoded event bytes and 100,000 events for the
whole attempt in process memory. Reserve 128 bytes and one event inside those caps for
final exit. Exhaustion freezes normal data with `limit_exceeded` at the first omitted
observation. One large output can therefore stop input/output/dimension recording for
the remaining attempt, even while readers are current. Finalization appends exactly one
exit with the next retained sequence after the frozen prefix; loss remains permanent.
A truncated exit tail reports `data_gap` with the same final-exit rule. Neither silently
evicts data nor stops the shell. A final nonempty page for `exited` must end with exit,
including after loss. An empty end read alone does not prove that the reader previously
validated exit. The future adapter must retain that validation across pages.

This is not S3 persistence or the export size bound. The lifetime caps are resource
bounds, not measured capacity for a four-hour session. Relevant loss makes the future
combined recording incomplete with a null score under P09. See the
[source decision](decisions/terminal-recording-source.md#lifetime-budget-and-consequence)
for the budget and conditional durable-trimming requirements. Root can alter this
source; the [Gateway client](decisions/gateway-terminal-recording-client.md) validates
wire data and continuity but cannot prove authenticity or complete capture.

Lifecycle sealing applies the saved cutoff, advances a durable cursor only after
commit, and waits for an observation strictly later than a millisecond cutoff before
excluding more equal-timestamp records. Loss after a
cutoff must not automatically invalidate a complete prefix before it.

Chunks have immutable keys that include the recorder generation and sequence range.
The gateway saves object references and event cursors only after successful uploads,
conditional on its current lease and recording still being open. Stale writers cannot
publish objects or complete a drain. Finalisation fixes the accepted references so late
uploads cannot change playback or scores. Unreferenced objects expire under retention.

The reference Bash configuration emits OSC 133 prompt and command markers. They mark prompt start, command start with
the command line, and command end with the exit status. The gateway removes them from the
forwarded stream and uses them to form command events. Without markers, it falls back to
input lines submitted at an idle prompt. Markers come from inside the learner's container
and can be altered. That affects only that learner's command events and the debrief items
derived from them. Monitor measurements are unaffected.

A command's output excerpt is the output between its start and end, with control
sequences removed and full-screen program output, such as `vi` or `less`, omitted. It is
bounded to 4,000 characters with a truncation flag. Lines typed inside a program the
command started, such as SQL at a `psql` prompt, are kept with that command for evidence
matching.

## Scoring

The first implementation reports raw components only. Weights and any combined score
remain open.

| Component                          | Definition                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `timeToRecoverySeconds`            | From `readyAt` to the start of the final sustained passing window. Null unless resolved           |
| `totalRequests`, `failedRequests`  | Monitor counters from `readyAt` to the outcome                                                    |
| `commandCount`                     | Recorded commands, as the proposed measure of investigation effort                                |
| `observedOutages`, `outageSeconds` | Health probe outage count and summed duration per probe. These do not assert who caused an outage |
| Assistance                         | Hints released, assistant turns, and proposals run                                                |

Reduced impact counts even when the root cause remains, because a mitigation lowers
`failedRequests`. Time to recovery starts at the passing window, not at its end, so the
sustain period is confirmation rather than a penalty.
Durations are seconds and may include fractions. Overlapping outages of different probes
each contribute their duration, so this component can exceed the session's elapsed time.

## Debrief derivation

The finaliser derives the debrief from the manifest and the recorded timeline:

1. **Key evidence** has a status. `observed` requires a matching `commandPatterns` rule
   and every `outputPatterns` rule to match the saved output excerpt of that same
   completed command. The first observed match gives `commandSeq`. A command match
   without matching output is `attempted`, with the first attempt's sequence. Otherwise
   it is `not_observed`, with a null sequence. This does not prove the learner missed or
   understood the evidence. Patterns are case-sensitive JavaScript regular expressions
   over at most 4,000 characters. A path mention, file-change capture, or full-screen
   editor with no saved output cannot establish that the original evidence was seen.
2. **Outages** come from monitor outage events. They have no automatic command cause.
3. **Possible harmful actions** match a trap's command pattern and precede an outage
   of its probe within the authored window. Each association includes `commandSeq` and
   `outageStartedAt`. This is a possible explanation based on timing, not proof of cause.
4. **Root cause, causal chain, and recommended recovery** are authored text.
5. **Assisted** is true when any hint, assistant turn, or proposal was used.

The saved session's `readyAt` and `endedAt` define the bounds, even if recording loss
removed lifecycle events. Only events within those bounds enter the derivation. A command
that completes after the cutoff cannot supply observed evidence. Terminal output is
learner-controlled, so these matches support reflection, not trusted assessment.
Unsupported command forms may remain `not_observed`. Monitor data alone determines
recovery and request impact.

The debrief aligns commands with metric samples and capture intervals. It shows state
observed around those commands, not proven per-command causation. The repository check
runs these rules against the
[example timeline](../packages/contracts/examples/timeline.json) and compares the result
with the [example debrief](../packages/contracts/examples/debrief.json).

An incomplete recording still permits a debrief of the saved data, with a visible
`recording.status: incomplete` and reason. Its `score` is null. Missing measurements
must not become zero, and missing records must not be described as learner mistakes.
The immutable debrief saves the outcome and missing-score status. Current progress
stores only `completedAttempts`; errors do not increment it. Richer progress views
remain separate work. Finalisation uses ordinary shared code in reconcile and sweep,
not another Lambda call. It atomically writes the result, progress, and matching
lock release after recording completion and confirmed task/schedule cleanup.

Admission pins the canonical private manifest SHA-256. Publication must store and
retain the immutable private manifest item before publishing its admission snapshot.
See [the evidence/debrief decision](decisions/evidence-debrief.md). Complete results
use sealed command receipts and Monitor data. Incomplete results retain safe saved
command and Monitor event projections without inventing final counters. The response
shows at most the first 50 outage and possible-harm details; complete raw components
still count all saved outages. Playback supplies the full retained timeline.

## Playback and retry

After the debrief, the learner can play back the attempt as a timeline. The terminal
recording runs in step with the metric series and timestamped capture intervals. Key
evidence, possible harmful actions, outages, and the start of recovery are highlighted.
Outage and recovery highlights point to their event time with a null `commandSeq`. Playback
reads stored data. It never restarts an environment.

The local exporter runs in existing reconcile/sweep finalisation after confirmed cleanup.
It pins the recording, terminal, lifecycle, and final Monitor receipt, resumes forward
from saved checkpoints, and processes at most 20 source pages per pass. It uploads
immutable exports before conditional reference/checkpoint commits. It uses no new lease.
The debrief, highlights, progress and matching-lock release commit before export work.
Pending passes return a normal result and continue through existing lifecycle hints,
with the sparse work index as interruption recovery. Completion removes export discovery
atomically. Playback returns `PLAYBACK_PENDING` while preparing. Expired sources save
an unavailable export receipt without object access. Export failure cannot withhold a
saved debrief or block the next attempt.

Terminal exports use asciicast v2. Keep one terminal renderer across chunks; align each
chunk's relative event times with its `startedAt`. Do not reset the screen at each chunk
header. Recorded input is data and must never execute. Output, dimensions, and exit
markers replay; OSC 133 command metadata is removed. Original bytes stay in private source
pages. Invalid or cut-off UTF-8 shows a replacement character. Metrics retain saved
public Monitor frames and the sealed final sample. Partial exports stop at the outcome
cutoff and remain visibly incomplete. Capture links use the requesting command's cutoff
eligibility and preserve the actual baseline/start/completion interval, including drain.
They do not claim an atomic snapshot or command causality.

Read APIs are separate disabled Lambdas. Playback pages expose at most 25 selected object
links and repeat the bounded saved highlights. The full timeline is paginated separately.
No browser player, backfill for old finalised records, or AWS deployment is included.
See [the playback decision](decisions/playback-api.md).

A retry starts a fresh task from the current published version. It is labelled `retry`
and never changes the first attempt, its debrief, or its score.

## Scenario validity harness

Each image version needs scripted evidence before publication:

1. Start a fresh environment and confirm the fault is present: validators fail and
   probes pass. With multiple validators, at least one must fail. Unaffected checks may pass.
2. Run the reference fix and confirm every validator is met within its sustain period
   plus a margin.
3. For each trap, in a fresh environment, run its commands and confirm its probe fails.
   Run the safe alternative, when defined, and confirm the probe keeps passing.
4. Repeat each Challenge 20 times to expose flaky environments and measure the variance
   in recovery time.
5. Play back each reference run and confirm that it matches its recorded output, logs,
   and metrics.

Locally the harness runs commands with `docker exec`. On Fargate there is no ECS Exec,
so it drives the terminal through the gateway like a learner, which also tests
recording.
