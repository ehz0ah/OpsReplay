import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPlaybackExportState,
  isPlaybackReference,
  playbackLimits,
  playbackObjectKey,
  type PlaybackExportState,
} from './playback-persistence.js';
import { isMonitorFinalEvidence } from './monitor-final.js';
const id = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-12T00:00:00.000Z';
const initial: PlaybackExportState = {
  schemaVersion: 1,
  cutoffAt: at,
  sourceSha256: 'a'.repeat(64),
  terminalCursor: 0,
  terminalBytes: 0,
  terminalCount: 0,
  terminalLastAt: null,
  columns: 80,
  rows: 24,
  utf8Tail: '',
  inputTail: '',
  markerPrefix: '',
  markerDiscard: false,
  markerEscaped: false,
  terminalDone: false,
  metricCursor: 0,
  metricScanKey: null,
  metricBytes: 0,
  metricCount: 0,
  metricLastAt: null,
  metricsDone: false,
  complete: false,
  unavailable: null,
};
test('export checkpoints reject incompatible completion, decoder, size and time states', () => {
  assert.ok(isPlaybackExportState(initial));
  assert.ok(
    isPlaybackExportState({
      ...initial,
      terminalDone: true,
      metricsDone: true,
      complete: true,
      unavailable: 'expired',
    }),
  );
  for (const update of [
    { extra: true },
    { complete: true },
    { unavailable: 'expired' },
    { terminalDone: true, utf8Tail: '8A==' },
    { markerPrefix: 'YQ==' },
    { markerEscaped: true },
    { terminalCursor: 100001 },
    { terminalBytes: playbackLimits.maximumTerminalBytes + 1 },
    { terminalCount: 1 },
    { metricCursor: 10001 },
    { metricLastAt: '2026-10-12T00:00:01.000Z' },
    { metricScanKey: 'CHUNK#hidden' },
  ])
    assert.equal(isPlaybackExportState({ ...initial, ...update }), false, JSON.stringify(update));
});
test('playback references bind session, source, sequence, hash, kind and interval to the object key', () => {
  const base = {
    schemaVersion: 1 as const,
    kind: 'terminal' as const,
    source: id,
    after: 0,
    nextSequence: 1,
    sha256: 'b'.repeat(64),
    byteLength: 100,
    startedAt: at,
    endedAt: at,
  };
  const value = { ...base, objectKey: playbackObjectKey(id, base) };
  assert.ok(isPlaybackReference(value, id));
  for (const update of [
    { source: null },
    { after: 1 },
    { nextSequence: 100001 },
    { byteLength: playbackLimits.maximumObjectBytes + 1 },
    { objectKey: 'sessions/another/data.cast' },
    { sha256: 'bad' },
    { endedAt: '2026-10-11T23:59:59.000Z' },
  ])
    assert.equal(isPlaybackReference({ ...value, ...update }, id), false);
  const empty = { ...base, kind: 'metrics' as const, source: null, nextSequence: 0 };
  assert.ok(isPlaybackReference({ ...empty, objectKey: playbackObjectKey(id, empty) }, id));
});
test('final Monitor receipts require a cutoff sample, source coverage and possible counters', () => {
  const value = {
    schemaVersion: 1,
    cutoffAt: at,
    source: id,
    cursor: 1,
    final: {
      type: 'metrics',
      sample: { at, values: { request_rate: 1 } },
      counters: { totalRequests: 10, failedRequests: 5 },
      recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    },
  };
  assert.ok(isMonitorFinalEvidence(value));
  for (const update of [
    { extra: true },
    { cursor: 0 },
    { source: null },
    { final: { ...value.final, counters: { totalRequests: 1, failedRequests: 2 } } },
    { final: { ...value.final, sample: { ...value.final.sample, at: '2026-10-12T00:00:01.000Z' } } },
  ])
    assert.equal(isMonitorFinalEvidence({ ...value, ...update }), false);
});
