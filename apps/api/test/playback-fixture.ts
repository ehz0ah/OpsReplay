import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { initialSessionLifecycle } from '../../../packages/contracts/private/session-lifecycle.js';
import { recordingRetainUntil } from '../../../packages/contracts/private/recording-retention.js';
import {
  initialTerminalCheckpoint,
  advanceTerminalCheckpoint,
  encodeTerminalPage,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  terminalPage,
  terminalReady,
  terminalOutput,
} from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { encodeSealedTerminalPage } from '../../../packages/contracts/private/terminal-sealing.js';
import { initialCommandParser } from '../../../packages/contracts/private/command-evidence.js';
import type { TerminalRecordingEvent } from '../../../packages/contracts/private/terminal-recording.js';
import type { MonitorRecordingState } from '../../../packages/contracts/private/monitor-persistence.js';
import { deriveDebrief, type DebriefManifest } from '../../../packages/session/src/debrief.js';
import { canonicalJson } from '../../../packages/session/src/canonical.js';
import { sessionRecord } from './session-fixture.js';

export const playbackAt = '2026-10-12T00:00:00.000Z';
export const playbackEnd = '2026-10-12T00:01:00.000Z';
export const playbackManifest = JSON.parse(
  readFileSync(new URL('../../../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
) as DebriefManifest;
export function playbackFixture(complete = false, pages = 2) {
  const id = randomUUID();
  const source = randomUUID();
  const monitorSource = randomUUID();
  const session = sessionRecord(id);
  Object.assign(session.view, {
    status: 'ended',
    statusReason: 'learner_ended',
    readyAt: playbackAt,
    endsAt: '2026-10-12T00:20:00.000Z',
    endedAt: playbackEnd,
    hints: { ...session.view.hints, nextAvailableAt: '2026-10-12T00:03:00.000Z' },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    recording: { status: complete ? 'complete' : 'incomplete', reason: complete ? null : 'data_gap' },
  });
  const lifecycle = {
    ...initialSessionLifecycle(id, playbackAt),
    readyAt: playbackAt,
    terminalSource: source,
    lastSeenAt: playbackAt,
    lastMonitorAt: playbackAt,
    taskStoppedAt: playbackEnd,
    schedulesDeleted: true,
    drainDeadlineAt: '2026-10-12T00:01:30.000Z',
    recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
  };
  const records = new Map<string, unknown>([
    ['STATE', session],
    ['LIFECYCLE', lifecycle],
  ]);
  const objects = new Map<string, Buffer>();
  let checkpoint = initialTerminalCheckpoint(terminalReady({ source }));
  for (let index = 0; index < pages; index++) {
    const events: TerminalRecordingEvent[] =
      index === 0
        ? [{ type: 'dimensions', sequence: 1, recordedAt: playbackAt, columns: 80, rows: 24 }]
        : [
            terminalOutput(
              index + 1,
              `2026-10-12T00:00:${String(Math.min(index, 59)).padStart(2, '0')}.000Z`,
              Buffer.from('visible\r\n'),
            ),
          ];
    const page = terminalPage(events, { source });
    checkpoint = advanceTerminalCheckpoint(checkpoint, page);
    const encoded = complete
      ? encodeSealedTerminalPage(id, 1, source, index, events)
      : encodeTerminalPage(id, 1, index, page);
    objects.set(encoded.reference.objectKey, encoded.body);
    records.set(
      `${complete ? 'TERMINAL_SEALED_CHUNK' : 'TERMINAL_CHUNK'}#${source}#${String(index + 1).padStart(6, '0')}`,
      encoded.reference,
    );
  }
  if (complete)
    checkpoint = { ...checkpoint, metadata: { ...checkpoint.metadata, observedAt: '2026-10-12T00:01:01.000Z' } };
  if (pages) records.set('TERMINAL_RECORDING', checkpoint);
  if (complete)
    records.set('TERMINAL_SEAL', {
      schemaVersion: 1,
      cutoffAt: playbackEnd,
      checkpoint,
      cursor: pages,
      pageCount: pages,
      recordedBytes: checkpoint.recordedBytes,
      lastAt: checkpoint.frontier?.recordedAt ?? null,
      excludedAt: null,
      complete: true,
    });
  const final = {
    type: 'metrics',
    sample: { at: playbackEnd, values: { request_rate: 1 } },
    counters: { totalRequests: 60, failedRequests: 30 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
  const frames = [
    {
      source: monitorSource,
      sequence: 1,
      recordedAt: playbackAt,
      payload: { ...final, sample: { ...final.sample, at: playbackAt } },
    },
  ];
  const monitor = complete
    ? {
        schemaVersion: 1,
        kind: 'sealed_monitor_recording',
        sessionId: id,
        recorderGeneration: 1,
        startedAt: playbackAt,
        cutoffAt: playbackEnd,
        source: monitorSource,
        cursor: 1,
        frames,
        final,
      }
    : {
        schemaVersion: 1,
        kind: 'monitor_page',
        sessionId: id,
        recorderGeneration: 1,
        startedAt: playbackAt,
        source: monitorSource,
        after: 0,
        nextSequence: 1,
        frames,
      };
  const bytes = Buffer.from(canonicalJson(monitor));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reference = {
    phase: complete ? ('sealed' as const) : ('live' as const),
    objectKey: `sessions/${id}/metrics/000000001/${complete ? 'sealed' : 'live'}/${monitorSource}/000001-000001-${sha256}.json`,
    sha256,
    source: monitorSource,
    after: 0,
    nextSequence: 1,
    frameCount: 1,
  };
  objects.set(reference.objectKey, bytes);
  if (!complete)
    records.set(`CHUNK#${monitorSource}#000000001#000001`, {
      schemaVersion: 1,
      kind: 'monitor_page',
      reference,
      committedAt: playbackAt,
    });
  const recording: MonitorRecordingState = {
    schemaVersion: 1,
    status: complete ? 'complete' : 'incomplete',
    recorderId: null,
    generation: 1,
    leaseExpiresAt: null,
    startedAt: playbackAt,
    source: monitorSource,
    cursor: 1,
    cutoffAt: playbackEnd,
    drainDeadlineAt: lifecycle.drainDeadlineAt,
    sealed: complete ? reference : null,
    retainUntil: recordingRetainUntil(complete ? playbackEnd : playbackAt, complete ? 'sealed' : 'provisional'),
    reason: complete ? null : 'data_gap',
    updatedAt: playbackEnd,
    completedAt: playbackEnd,
  };
  records.set('RECORDING', recording);
  if (complete) {
    records.set('MONITOR_FINAL', { schemaVersion: 1, cutoffAt: playbackEnd, source: monitorSource, cursor: 1, final });
    records.set('MONITOR_EVENTS#000001', {
      schemaVersion: 1,
      source: monitorSource,
      after: 0,
      nextSequence: 1,
      events: [],
    });
    if (pages) records.set('SEALED_COMMAND_PARSER', { ...initialCommandParser(source), cursor: pages });
  }
  const debrief = deriveDebrief(playbackManifest, session, [], [], complete ? final.counters : null);
  return { id, source, monitorSource, session, lifecycle, records, objects, recording, debrief, reference };
}
