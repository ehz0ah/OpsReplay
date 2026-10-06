import assert from 'node:assert/strict';
import test from 'node:test';
import { Measurements } from '../src/measurements.js';
import { RecoveryChecks } from '../src/recovery.js';
import { limits } from '../src/types.js';

test('RPS, failures, and p95 describe the same five-second request window', async () => {
  const data = new Measurements(1000);
  for (let i = 1; i <= 20; i++) data.record({ startedAt: 1000, completedAt: 1000 + i * 100,
    durationMs: i * 10, failed: i <= 5 });
  const result = await data.snapshot(6000);
  assert.deepEqual(result.counters, { totalRequests: 20, failedRequests: 5 });
  assert.equal(result.sample.values.request_rate, 4);
  assert.equal(result.sample.values.error_rate, 25);
  // Summary uses interpolated quantiles. The 95th percentile is in the top two observations.
  assert.ok(result.sample.values.latency_p95! >= 190 && result.sample.values.latency_p95! <= 200);
  const later = await data.snapshot(12000);
  assert.deepEqual(later.counters, result.counters);
  assert.deepEqual(later.sample.values, { request_rate: 0 });
});

test('warm-up and post-cutoff requests do not change a sealed period', async () => {
  const data = new Measurements(1000);
  data.record({ startedAt: 900, completedAt: 1100, durationMs: 200, failed: true });
  data.record({ startedAt: 1100, completedAt: 1200, durationMs: 100, failed: false });
  data.record({ startedAt: 1400, completedAt: 1900, durationMs: 500, failed: true });
  const [earlier, later] = await Promise.all([data.snapshot(1500), data.snapshot(2000)]);
  assert.deepEqual(earlier.counters, { totalRequests: 1, failedRequests: 0 });
  assert.deepEqual(later.counters, { totalRequests: 2, failedRequests: 1 });
  assert.deepEqual(await data.snapshot(1500), earlier);
});

test('empty periods and malformed times cannot fabricate latency', async () => {
  const data = new Measurements(1000);
  assert.deepEqual((await data.snapshot(1000)).sample.values, {});
  assert.throws(() => data.record({ startedAt: 1100, completedAt: 1000, durationMs: -100, failed: false }), /invalid_boundary/);
  await assert.rejects(data.snapshot(NaN), /invalid_boundary/);
});

test('sustained recovery needs completed checks, and a late failure restarts the window', () => {
  const checks = new RecoveryChecks([
    { id: 'a', check: { kind: 'journey', journey: 'a' }, sustainSeconds: 60 },
    { id: 'b', check: { kind: 'journey', journey: 'a' }, sustainSeconds: 60 },
  ]);
  checks.result(0, true, 0);
  checks.result(1, true, 0);
  checks.result(0, true, 59000);
  checks.result(1, true, 59000);
  assert.equal(checks.view().sustainedSeconds, 59);
  assert.equal(checks.view().state, 'sustaining');
  checks.result(1, false, 59999);
  assert.equal(checks.view().state, 'failing');
  checks.result(0, true, 60000);
  checks.result(1, true, 60000);
  assert.equal(checks.view().sustainedSeconds, 0);
  checks.result(0, true, 120000);
  checks.result(1, true, 120000);
  assert.equal(checks.view().state, 'met');
});

test('each validator must meet its own sustain period', () => {
  const checks = new RecoveryChecks([
    { id: 'a', check: { kind: 'journey', journey: 'a' }, sustainSeconds: 10 },
    { id: 'b', check: { kind: 'journey', journey: 'a' }, sustainSeconds: 60 },
  ]);
  checks.result(0, true, 50000);
  checks.result(1, true, 0);
  checks.result(0, true, 59999);
  checks.result(1, true, 60000);
  assert.equal(checks.view().state, 'sustaining');
  checks.result(0, true, 60000);
  assert.equal(checks.view().state, 'met');
});

test('an instant completion at the start belongs to the first sample', async () => {
  const data = new Measurements(1000);
  data.record({ startedAt: 1000, completedAt: 1000, durationMs: 0, failed: false });
  const result = await data.snapshot(6000);
  assert.equal(result.sample.values.request_rate, 0.2);
  assert.equal(result.sample.values.latency_p95, 0);
});

test('request history is bounded and overflow is explicit', () => {
  const data = new Measurements(0);
  const record = { startedAt: 0, completedAt: 1, durationMs: 1, failed: false };
  for (let i = 0; i < limits.records; i++) data.record(record);
  assert.throws(() => data.record(record), /record_limit/);
});
