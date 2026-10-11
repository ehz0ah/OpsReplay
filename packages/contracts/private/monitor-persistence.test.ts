import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMonitorLifecycleObservation } from './monitor-persistence.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const value = {
  schemaVersion: 1,
  sessionId: id,
  startedAt: '2026-10-12T00:00:00.000Z',
  source: id,
  cursor: 2,
  sequence: 2,
  at: '2026-10-12T00:01:00.000Z',
  recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
};
test('monitor observation binds session, stream, sequence, and feasible sustain duration', () => {
  assert.equal(isMonitorLifecycleObservation(value, id), true);
  for (const invalid of [
    { ...value, extra: true },
    { ...value, cursor: 1 },
    { ...value, source: 'wrong' },
    { ...value, at: '2026-10-12T00:00:01.000Z' },
    { ...value, recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 61 } },
  ])
    assert.equal(isMonitorLifecycleObservation(invalid, id), false);
});
