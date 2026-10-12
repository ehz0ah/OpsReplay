import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMonitorLiveTelemetry, monitorLiveTelemetryKey } from './live-telemetry.js';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const startedAt = '2026-10-13T00:00:00.000Z';
const value = {
  schemaVersion: 1,
  sessionId,
  startedAt,
  source: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  frontier: 2,
  sequence: 2,
  recordedAt: '2026-10-13T00:00:05.000Z',
  metric: {
    type: 'metrics',
    sample: { at: '2026-10-13T00:00:05.000Z', values: { request_rate: 10, error_rate: 0.2 } },
    counters: { totalRequests: 50, failedRequests: 10 },
    recovery: { state: 'sustaining', sustainedSeconds: 5, requiredSeconds: 60 },
  },
};

test('live Monitor telemetry binds one public metric to an accepted recording frontier', () => {
  assert.equal(isMonitorLiveTelemetry(value, sessionId), true);
  assert.deepEqual(monitorLiveTelemetryKey(sessionId), { PK: `SESSION#${sessionId}`, SK: 'LIVE_MONITOR' });

  for (const invalid of [
    { ...value, extra: true },
    { ...value, sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    { ...value, source: 'private-address' },
    { ...value, frontier: 1 },
    { ...value, sequence: 0 },
    { ...value, recordedAt: '2026-10-12T23:59:59.000Z' },
    { ...value, metric: { ...value.metric, sample: { ...value.metric.sample, at: '2026-10-13T00:00:06.000Z' } } },
    {
      ...value,
      metric: {
        ...value.metric,
        recovery: { state: 'sustaining', sustainedSeconds: 6, requiredSeconds: 60 },
      },
    },
  ]) {
    assert.equal(isMonitorLiveTelemetry(invalid, sessionId), false);
  }
});

test('live Monitor telemetry rejects an invalid session key', () => {
  assert.throws(() => monitorLiveTelemetryKey('not-a-session'), /identity is invalid/);
});
