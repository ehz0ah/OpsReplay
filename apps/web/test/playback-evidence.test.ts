import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import { EvidenceRecording, playbackRange } from '../src/playback/evidence.js';
import { PlaybackPlayer, type PlayerState } from '../src/playback/player.js';
const start = Date.parse('2026-10-18T00:00:00Z'),
  at = (offset: number) => new Date(start + offset).toISOString();
const track = { startedAt: at(0), endedAt: at(10000), url: 'https://qa.s3.amazonaws.com/metrics' };
const reference = {
  commandSeq: 1,
  baselineAt: at(0),
  startedAt: at(5000),
  completedAt: at(12000),
  url: 'https://qa.s3.amazonaws.com/capture',
};
const playback: PublicTypes['Playback'] = {
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  recording: { status: 'complete', reason: null },
  expiresAt: at(300000),
  nextCursor: null,
  highlights: [],
  terminal: [{ ...track, url: 'https://qa.s3.amazonaws.com/terminal' }],
  metrics: [track],
  captures: [reference],
};
const sample = (offset: number) => ({ at: at(offset), values: { error_rate: offset < 10000 ? 50 : 0 } });
const metrics = JSON.stringify({
  schemaVersion: 1,
  kind: 'playback_metrics',
  frames: [0, 5000, 10000].map((offset, index) => ({
    source: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sequence: index + 1,
    recordedAt: at(offset),
    payload: {
      type: 'metrics',
      sample: sample(offset),
      counters: { totalRequests: 100, failedRequests: 50 },
      recovery: { state: 'failing', requiredSeconds: 60, sustainedSeconds: 0 },
    },
  })),
});
const capture: PublicTypes['PlaybackCapture'] = {
  schemaVersion: 1,
  commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  commandSeq: 1,
  sequence: 1,
  baselineAt: reference.baselineAt,
  startedAt: reference.startedAt,
  completedAt: reference.completedAt,
  files: [{ path: '/etc/config', before: 'old', after: 'new' }],
  logs: [],
  metrics: sample(10000),
  incomplete: false,
  unavailable: false,
};
test('shared metadata range includes metric-only and post-terminal capture time', () => {
  assert.deepEqual(playbackRange(playback), { start, end: start + 12000 });
  assert.deepEqual(playbackRange({ ...playback, terminal: [], captures: [] }), { start, end: start + 10000 });
  assert.equal(playbackRange({ ...playback, terminal: [], metrics: [], captures: [] }), null);
  assert.throws(() => playbackRange({ ...playback, captures: [{ ...reference, completedAt: at(4000) }] }), /interval/);
});
test('metrics and captures follow the same position without revealing future state and reuse bounded reads', async () => {
  const reads: string[] = [];
  const source = new EvidenceRecording(async (url) => {
    reads.push(url);
    return url === track.url ? metrics : JSON.stringify(capture);
  });
  const early = await source.render(playback, start + 6000, new AbortController().signal);
  assert.deepEqual(
    early.samples.map((value) => value.at),
    [at(0), at(5000)],
  );
  assert.equal(early.capture, null);
  assert.deepEqual(early.pending, reference);
  assert.deepEqual(reads, [track.url]);
  const complete = await source.render(playback, start + 12000, new AbortController().signal);
  assert.deepEqual(complete.capture, capture);
  assert.equal(complete.pending, null);
  const back = await source.render(playback, start, new AbortController().signal);
  assert.equal(back.capture, null);
  assert.equal(back.pending, null);
  assert.deepEqual(back.samples, [sample(0)]);
  await source.render(playback, start + 12000, new AbortController().signal);
  assert.deepEqual(reads, [track.url, reference.url]);
});
test('metadata continuation adds evidence at the current time and failed or cancelled reads are retryable', async () => {
  let calls = 0;
  const source = new EvidenceRecording(async (_url, signal) => {
    calls++;
    if (calls === 1) throw new Error('Recording links expired.');
    signal.throwIfAborted();
    return metrics;
  });
  const noMetrics = { ...playback, metrics: [], captures: [] };
  assert.deepEqual((await source.render(noMetrics, start + 5000, new AbortController().signal)).samples, []);
  await assert.rejects(source.render(playback, start + 5000, new AbortController().signal), /expired/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(source.render(playback, start + 5000, cancelled.signal));
  const loaded = await source.render({ ...playback, captures: [] }, start + 5000, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(loaded.samples.length, 2);
});
test('capture selection uses completion time and retains explicit incomplete data', async () => {
  const later = { ...reference, commandSeq: 2, startedAt: at(8000), completedAt: at(15000), url: reference.url + '-2' };
  const source = new EvidenceRecording(async (url) =>
    url === track.url
      ? metrics
      : JSON.stringify(
          url === reference.url
            ? capture
            : {
                ...capture,
                commandSeq: 2,
                startedAt: later.startedAt,
                completedAt: later.completedAt,
                incomplete: true,
                unavailable: true,
                files: [],
              },
        ),
  );
  const middle = await source.render(
    { ...playback, captures: [later, reference] },
    start + 13000,
    new AbortController().signal,
  );
  assert.equal(middle.capture?.commandSeq, 1);
  assert.equal(middle.pending?.commandSeq, 2);
  const end = await source.render(
    { ...playback, captures: [later, reference] },
    start + 15000,
    new AbortController().signal,
  );
  assert.equal(end.capture?.unavailable, true);
  assert.equal(end.capture?.incomplete, true);
});
test('a cancelled evidence read cannot publish a stale playback position', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const source = new EvidenceRecording(async () => {
    entered();
    await gate;
    return metrics;
  });
  const states: PlayerState[] = [];
  let current = start;
  const control = new PlaybackPlayer(
    { start, end: start + 12000 },
    async (time, signal) => {
      const result = await source.render({ ...playback, captures: [] }, time, signal);
      signal.throwIfAborted();
      current = result.at;
    },
    (state) => states.push(state),
  );
  const old = control.seek(start + 10000);
  await started;
  const latest = control.seek(start);
  release();
  await Promise.all([old, latest]);
  assert.equal(current, start);
  assert.equal(states.at(-1)?.at, start);
  assert.ok(!states.some((state) => state.status === 'paused' && state.at === start + 10000));
  control.dispose();
});
test('aggregate sample bounds and mismatched capture data fail closed', async () => {
  const many = JSON.stringify({
    schemaVersion: 1,
    kind: 'playback_metrics',
    frames: Array.from({ length: 6000 }, (_, index) => ({
      source: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sequence: index + 1,
      recordedAt: at(0),
      payload: {
        type: 'metrics',
        sample: sample(0),
        counters: { totalRequests: 100, failedRequests: 50 },
        recovery: { state: 'failing', requiredSeconds: 60, sustainedSeconds: 0 },
      },
    })),
  });
  const source = new EvidenceRecording(async () => many);
  await assert.rejects(
    source.render(
      {
        ...playback,
        metrics: [
          { ...track, endedAt: at(0) },
          { ...track, url: track.url + '-2' },
        ],
        captures: [],
      },
      start,
      new AbortController().signal,
    ),
    /sample limit/,
  );
  const wrong = new EvidenceRecording(async () => JSON.stringify({ ...capture, commandSeq: 2 }));
  await assert.rejects(
    wrong.render({ ...playback, metrics: [] }, start + 12000, new AbortController().signal),
    /match/,
  );
});
