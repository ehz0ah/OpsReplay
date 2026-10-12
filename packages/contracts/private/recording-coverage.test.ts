import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceTerminalCheckpoint, initialTerminalCheckpoint } from './terminal-persistence.js';
import { terminalPage, terminalReady } from './test-support/terminal-fixture.js';
import { isRecordingCoverage, recordingSealingDurationMs } from './recording-coverage.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cutoffAt = '2026-10-12T00:00:01.000Z';
const coveredAt = '2026-10-12T00:00:02.000Z';
const terminal = advanceTerminalCheckpoint(
  initialTerminalCheckpoint(terminalReady()),
  terminalPage(undefined, { observedAt: coveredAt }),
);
const value = {
  schemaVersion: 1,
  sessionId: id,
  cutoffAt,
  coveredAt,
  taskDrainDeadlineAt: '2026-10-12T00:00:31.000Z',
  sealingDeadlineAt: new Date(Date.parse(coveredAt) + recordingSealingDurationMs).toISOString(),
  terminal,
  monitor: {
    phase: 'sealed',
    source: null,
    after: 0,
    nextSequence: 0,
    frameCount: 0,
    sha256: 'a'.repeat(64),
    objectKey: `sessions/${id}/metrics/000000001/sealed/empty/000000-000000-${'a'.repeat(64)}.json`,
  },
  final: {
    type: 'metrics',
    sample: { at: cutoffAt, values: { request_rate: 1 } },
    counters: { totalRequests: 1, failedRequests: 1 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  },
};
test('coverage validates task cutoff proof and a separate fixed sealing deadline', () => {
  assert.equal(isRecordingCoverage(value, id), true);
  for (const bad of [
    { ...value, extra: true },
    { ...value, coveredAt: value.taskDrainDeadlineAt },
    { ...value, sealingDeadlineAt: value.taskDrainDeadlineAt },
    { ...value, terminal: { ...terminal, metadata: { ...terminal.metadata, observedAt: cutoffAt } } },
    { ...value, final: { ...value.final, sample: { ...value.final.sample, at: coveredAt } } },
    { ...value, terminal: { ...terminal, metadata: { ...terminal.metadata, observedAt: value.taskDrainDeadlineAt } } },
    {
      ...value,
      monitor: {
        ...value.monitor,
        objectKey: value.monitor.objectKey.replace(id, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      },
    },
  ])
    assert.equal(isRecordingCoverage(bad, id), false);
});
