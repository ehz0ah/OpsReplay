import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MonitorFrame, MonitorMetricFrame } from '../src/monitor-client.js';
import type { MonitorChunkStore, StoredMonitorChunk } from '../src/monitor-chunk-store.js';
import { DurableMonitorRecordingSink } from '../src/monitor-recording-sink.js';
import type { MonitorRecordingStateStore, MonitorRecorderLease } from '../src/monitor-recording-store.js';

const lease: MonitorRecorderLease = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  recorderId: 'gateway-1',
  generation: 3,
};
const startedAt = '2026-10-07T00:00:00.000Z';
const source = '22222222-2222-4222-8222-222222222222';
const now = '2026-10-07T00:00:04.000Z';

function metric(at: string): MonitorMetricFrame {
  return {
    type: 'metrics',
    sample: { at, values: { request_rate: 1 } },
    counters: { totalRequests: 1, failedRequests: 0 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
}

function frame(): MonitorFrame {
  const recordedAt = '2026-10-07T00:00:01.000Z';
  return { source, sequence: 1, recordedAt, payload: metric(recordedAt) };
}

function reference(phase: 'live' | 'sealed'): StoredMonitorChunk {
  return {
    phase,
    objectKey: `sessions/${lease.sessionId}/metrics/000000003/${phase}/${source}/000001-000001-${'a'.repeat(64)}.json`,
    sha256: 'a'.repeat(64),
    source,
    after: phase === 'live' ? 0 : 0,
    nextSequence: 1,
    frameCount: 1,
  };
}

test('uploads each object before it advances durable recording state', async () => {
  const order: string[] = [];
  const chunks: MonitorChunkStore = {
    putLive: async () => {
      order.push('upload-live');
      return reference('live');
    },
    putSealed: async () => {
      order.push('upload-sealed');
      return reference('sealed');
    },
  };
  const recordings: MonitorRecordingStateStore = {
    begin: async (actualLease, actualStartedAt, actualNow) => {
      assert.deepEqual(actualLease, lease);
      assert.equal(actualStartedAt, startedAt);
      assert.equal(actualNow, now);
      order.push('commit-begin');
    },
    append: async (_actualLease, _actualStartedAt, actualReference, actualNow) => {
      assert.deepEqual(actualReference, reference('live'));
      assert.equal(actualNow, now);
      order.push('commit-live');
    },
    seal: async (_actualLease, _value, actualReference, actualNow) => {
      assert.deepEqual(actualReference, reference('sealed'));
      assert.equal(actualNow, now);
      order.push('commit-sealed');
    },
  };
  const sink = new DurableMonitorRecordingSink({ lease, chunks, recordings, now: () => now });
  const batch = { startedAt, source, after: 0, nextSequence: 1, frames: [frame()] };
  const sealed = {
    startedAt,
    cutoffAt: '2026-10-07T00:00:02.000Z',
    source,
    cursor: 1,
    frames: [frame()],
    final: metric('2026-10-07T00:00:02.000Z'),
  };

  await sink.begin({ startedAt });
  await sink.append(batch);
  await sink.seal(sealed);

  assert.deepEqual(order, ['commit-begin', 'upload-live', 'commit-live', 'upload-sealed', 'commit-sealed']);
});

test('does not advance state when an object upload fails', async () => {
  let commits = 0;
  const chunks: MonitorChunkStore = {
    putLive: async () => {
      throw new Error('upload failed');
    },
    putSealed: async () => {
      throw new Error('upload failed');
    },
  };
  const recordings: MonitorRecordingStateStore = {
    begin: async () => {},
    append: async () => {
      commits++;
    },
    seal: async () => {
      commits++;
    },
  };
  const sink = new DurableMonitorRecordingSink({ lease, chunks, recordings });

  await assert.rejects(
    sink.append({ startedAt, source, after: 0, nextSequence: 1, frames: [frame()] }),
    /upload failed/,
  );
  await assert.rejects(
    sink.seal({
      startedAt,
      cutoffAt: '2026-10-07T00:00:02.000Z',
      source,
      cursor: 1,
      frames: [frame()],
      final: metric('2026-10-07T00:00:02.000Z'),
    }),
    /upload failed/,
  );
  assert.equal(commits, 0);
});
