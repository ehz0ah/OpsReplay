import assert from 'node:assert/strict';
import test from 'node:test';
import { isCaptureBaseline, isFileCapture } from './file-capture.js';
import { isCaptureState } from './capture-persistence.js';

const at = '2026-10-12T00:00:00.000Z';
const baseline = { baselineAt: at, incomplete: false, unavailable: false };
const capture = {
  schemaVersion: 1,
  commandId: '22222222-2222-4222-8222-222222222222',
  commandSeq: 1,
  sequence: 1,
  baselineAt: at,
  startedAt: at,
  completedAt: at,
  files: [],
  logs: [],
  metrics: { at, values: { request_rate: 1 } },
  incomplete: false,
  unavailable: false,
};
const state = {
  schemaVersion: 1,
  baseline,
  cursor: 0,
  sequence: 0,
  retainedBytes: 0,
  incomplete: false,
  unavailable: false,
};

test('bounded excerpts remain valid while unavailable evidence requires an incomplete warning', () => {
  assert.equal(isCaptureBaseline(baseline), true);
  assert.equal(isFileCapture(capture), true);
  assert.equal(isCaptureState(state), true);
  assert.equal(isFileCapture({ ...capture, incomplete: true }), true);
  assert.equal(isFileCapture({ ...capture, metrics: null, incomplete: true, unavailable: true }), true);
  for (const invalid of [
    { ...capture, unavailable: true },
    { ...capture, metrics: null, incomplete: true },
    { ...capture, unavailable: undefined },
    { ...capture, incomplete: true, files: [{ path: '/etc/config', before: 'before', after: null }] },
  ])
    assert.equal(isFileCapture(invalid), false);
  assert.equal(isCaptureBaseline({ ...baseline, unavailable: true }), false);
  assert.equal(isCaptureState({ ...state, unavailable: true }), false);
  assert.equal(
    isCaptureState({ ...state, baseline: { ...baseline, incomplete: true, unavailable: true }, incomplete: true }),
    false,
  );
  // Old private records fail closed. These fields require a coordinated release.
  const { unavailable: _unavailable, ...legacy } = baseline;
  assert.equal(isCaptureBaseline(legacy), false);
});
