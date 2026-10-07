import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MonitorFrame, MonitorFramePage, MonitorMetricFrame, MonitorSealResult } from '../src/monitor-client.js';
import { MonitorClientError } from '../src/monitor-client.js';
import type {
  MonitorRecordingBatch,
  MonitorRecordingCheckpoint,
  MonitorRecordingClient,
  MonitorRecordingSink,
  MonitorRecordingStart,
  SealedMonitorRecording,
} from '../src/monitor-recorder.js';
import { MonitorRecorder, MonitorRecorderError } from '../src/monitor-recorder.js';

const startedAt = '2026-10-07T00:00:00.000Z';
const source = '11111111-1111-4111-8111-111111111111';

function metric(at: string): MonitorMetricFrame {
  return {
    type: 'metrics',
    sample: { at, values: { request_rate: 1, error_rate: 100, latency_p95_ms: 4 } },
    counters: { totalRequests: 5, failedRequests: 5 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
}

function frame(sequence: number, recordedAt: string): MonitorFrame {
  return { source, sequence, recordedAt, payload: metric(recordedAt) };
}

class FakeClient implements MonitorRecordingClient {
  readonly starts: AbortSignal[] = [];
  readonly reads: { after: number; expectedSource?: string }[] = [];
  readonly seals: string[] = [];
  sealed = false;
  streamStartedAt = startedAt;
  finalSampleAt: string | undefined;
  returnUnsealedAfterSeal = false;

  constructor(
    readonly liveFrames: MonitorFrame[],
    readonly pageSize = 100,
  ) {}

  async start(signal?: AbortSignal): Promise<{ startedAt: string }> {
    if (signal) this.starts.push(signal);
    else this.starts.push(new AbortController().signal);
    return { startedAt: this.streamStartedAt };
  }

  async read(after: number, expectedSource?: string, _signal?: AbortSignal): Promise<MonitorFramePage> {
    this.reads.push(expectedSource === undefined ? { after } : { after, expectedSource });
    const available = this.sealed
      ? this.liveFrames.filter((value) => value.recordedAt <= this.seals[0]!)
      : this.liveFrames;
    const frames = available.filter((value) => value.sequence > after).slice(0, this.pageSize);
    return {
      frames: structuredClone(frames),
      nextSequence: frames.at(-1)?.sequence ?? after,
      sealed: this.sealed && !this.returnUnsealedAfterSeal,
    };
  }

  async seal(cutoffAt: string, _signal?: AbortSignal): Promise<MonitorSealResult> {
    this.seals.push(cutoffAt);
    this.sealed = true;
    return { cutoffAt, final: metric(this.finalSampleAt ?? cutoffAt) };
  }
}

class MemorySink implements MonitorRecordingSink {
  readonly starts: MonitorRecordingStart[] = [];
  readonly batches: MonitorRecordingBatch[] = [];
  sealed: SealedMonitorRecording | undefined;
  failBegin = false;
  failAppend = false;
  failSeal = false;
  onAppend: (() => void) | undefined;

  async begin(value: MonitorRecordingStart): Promise<void> {
    if (this.failBegin) throw new Error('begin failed');
    if (this.starts.length > 0) assert.deepEqual(value, this.starts[0]);
    else this.starts.push(structuredClone(value));
  }

  async append(value: MonitorRecordingBatch): Promise<void> {
    if (this.failAppend) throw new Error('append failed');
    this.batches.push(structuredClone(value));
    this.onAppend?.();
  }

  async seal(value: SealedMonitorRecording): Promise<void> {
    if (this.failSeal) throw new Error('seal failed');
    this.sealed = structuredClone(value);
  }
}

function recorderError(code: MonitorRecorderError['code']): (error: unknown) => boolean {
  return (error) => error instanceof MonitorRecorderError && error.code === code;
}

test('records committed pages and replaces provisional data with the sealed stream', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z'), frame(2, '2026-10-07T00:00:03.000Z')], 1);
  const sink = new MemorySink();
  const controller = new AbortController();
  sink.onAppend = () => {
    if (sink.batches.length === 2) controller.abort();
  };
  const recorder = new MonitorRecorder({ client, sink, pollIntervalMs: 50 });

  assert.deepEqual(await recorder.begin(), { startedAt });
  assert.deepEqual(await recorder.record(controller.signal), { startedAt, source, cursor: 2 });
  assert.deepEqual(
    sink.batches.map((value) => [value.after, value.nextSequence]),
    [
      [0, 1],
      [1, 2],
    ],
  );

  const cutoffAt = '2026-10-07T00:00:02.000Z';
  const sealed = await recorder.seal(cutoffAt);
  assert.equal(sealed.cursor, 1);
  assert.deepEqual(
    sealed.frames.map((value) => value.sequence),
    [1],
  );
  assert.equal(sealed.final.sample.at, cutoffAt);
  assert.deepEqual(sink.sealed, sealed);
  assert.deepEqual(recorder.checkpoint, { startedAt, source, cursor: 1 });
});

test('does not advance the cursor until the sink commits a page', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({ client, sink, pollIntervalMs: 50 });
  await recorder.begin();
  sink.failAppend = true;

  await assert.rejects(recorder.record(new AbortController().signal), /append failed/);
  assert.deepEqual(recorder.checkpoint, { startedAt, source: null, cursor: 0 });

  sink.failAppend = false;
  const controller = new AbortController();
  sink.onAppend = () => controller.abort();
  assert.deepEqual(await recorder.record(controller.signal), { startedAt, source, cursor: 1 });
  assert.deepEqual(
    client.reads.map((value) => value.after),
    [0, 0],
  );
});

test('repeats the same sequence range after an uncertain append result', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({ client, sink, pollIntervalMs: 50 });
  const controller = new AbortController();
  let responseLost = true;
  sink.append = async (value) => {
    if (sink.batches.length === 0) sink.batches.push(structuredClone(value));
    else assert.deepEqual(value, sink.batches[0]);
    if (responseLost) throw new Error('append response lost');
    controller.abort();
  };
  await recorder.begin();

  await assert.rejects(recorder.record(new AbortController().signal), /append response lost/);
  assert.deepEqual(recorder.checkpoint, { startedAt, source: null, cursor: 0 });
  responseLost = false;
  assert.deepEqual(await recorder.record(controller.signal), { startedAt, source, cursor: 1 });
  assert.equal(sink.batches.length, 1);
  assert.deepEqual(
    client.reads.map((value) => value.after),
    [0, 0],
  );
});

test('retries an uncertain sink begin through the idempotent monitor start', async () => {
  const client = new FakeClient([]);
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({ client, sink });
  sink.failBegin = true;

  await assert.rejects(recorder.begin(), /begin failed/);
  assert.deepEqual(recorder.checkpoint, { startedAt: null, source: null, cursor: 0 });

  sink.failBegin = false;
  assert.deepEqual(await recorder.begin(), { startedAt });
  assert.equal(client.starts.length, 2);
  assert.deepEqual(recorder.checkpoint, { startedAt, source: null, cursor: 0 });
});

test('resumes from a saved checkpoint after verifying the same measurement stream', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z'), frame(2, '2026-10-07T00:00:02.000Z')]);
  const sink = new MemorySink();
  const checkpoint: MonitorRecordingCheckpoint = { startedAt, source, cursor: 1 };
  const recorder = new MonitorRecorder({ client, sink, checkpoint, pollIntervalMs: 50 });
  const controller = new AbortController();
  sink.onAppend = () => controller.abort();

  assert.deepEqual(await recorder.begin(), { startedAt });
  assert.deepEqual(await recorder.record(controller.signal), { startedAt, source, cursor: 2 });
  assert.equal(client.starts.length, 1);
  assert.deepEqual(client.reads[0], { after: 1, expectedSource: source });
  assert.equal(sink.starts.length, 0);
  assert.equal(sink.batches[0]!.after, 1);
});

test('a cancelled polling request stops cleanly without changing the checkpoint', async () => {
  const client = new FakeClient([]);
  client.read = async (_after, _expectedSource, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new MonitorClientError('cancelled')), { once: true });
    });
    throw new Error('unreachable');
  };
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({ client, sink, pollIntervalMs: 50 });
  await recorder.begin();
  const controller = new AbortController();
  const recording = recorder.record(controller.signal);
  await assert.rejects(recorder.seal('2026-10-07T00:00:02.000Z'), recorderError('invalid_state'));
  controller.abort();

  assert.deepEqual(await recording, { startedAt, source: null, cursor: 0 });
});

test('a failed final commit can retry the idempotent monitor seal', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({ client, sink });
  await recorder.begin();
  sink.failSeal = true;

  await assert.rejects(recorder.seal('2026-10-07T00:00:02.000Z'), /seal failed/);
  sink.failSeal = false;
  const sealed = await recorder.seal('2026-10-07T00:00:02.000Z');

  assert.equal(sealed.cursor, 1);
  assert.equal(client.seals.length, 2);
  assert.ok(sink.sealed);
});

test('replaces provisional frames with a valid empty sealed stream', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:00.001Z')]);
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({ client, sink, pollIntervalMs: 50 });
  const controller = new AbortController();
  sink.onAppend = () => controller.abort();
  await recorder.begin();
  await recorder.record(controller.signal);
  assert.deepEqual(recorder.checkpoint, { startedAt, source, cursor: 1 });

  sink.failSeal = true;
  await assert.rejects(recorder.seal(startedAt), /seal failed/);
  assert.deepEqual(recorder.checkpoint, { startedAt, source, cursor: 1 });

  sink.failSeal = false;
  const sealed = await recorder.seal(startedAt);

  assert.deepEqual(sealed.frames, []);
  assert.equal(sealed.source, null);
  assert.equal(sealed.cursor, 0);
  assert.equal(client.seals.length, 2);
  assert.deepEqual(sink.sealed, sealed);
  assert.deepEqual(recorder.checkpoint, { startedAt, source: null, cursor: 0 });
});

test('isolates the sealed result and checkpoint from sink mutations', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  const sink = new MemorySink();
  sink.seal = async (value) => {
    (value.frames as MonitorFrame[]).splice(0);
    value.cursor = 0;
    value.final.sample.values.request_rate = 999;
  };
  const recorder = new MonitorRecorder({ client, sink });
  await recorder.begin();

  const sealed = await recorder.seal('2026-10-07T00:00:02.000Z');

  assert.equal(sealed.frames.length, 1);
  assert.equal(sealed.cursor, 1);
  assert.equal(sealed.final.sample.values.request_rate, 1);
  assert.deepEqual(recorder.checkpoint, { startedAt, source, cursor: 1 });
});

test('a replacement can complete an already sealed monitor from its checkpoint', async () => {
  const cutoffAt = '2026-10-07T00:00:02.000Z';
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  client.sealed = true;
  client.seals.push(cutoffAt);
  const sink = new MemorySink();
  const recorder = new MonitorRecorder({
    client,
    sink,
    checkpoint: { startedAt, source, cursor: 1 },
  });

  const sealed = await recorder.seal(cutoffAt);

  assert.equal(client.starts.length, 0);
  assert.equal(sealed.cursor, 1);
  assert.deepEqual(sink.sealed, sealed);
});

test('rejects invalid checkpoints, bounds, and sealed monitor data', async () => {
  const client = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z'), frame(2, '2026-10-07T00:00:02.000Z')]);
  const sink = new MemorySink();
  assert.throws(
    () =>
      new MonitorRecorder({
        client,
        sink,
        checkpoint: { startedAt: null, source, cursor: 1 },
      }),
    recorderError('invalid_config'),
  );
  assert.throws(() => new MonitorRecorder({ client, sink, pollIntervalMs: 10 }), recorderError('invalid_config'));

  const limited = new MonitorRecorder({ client, sink, maximumFrames: 1 });
  await limited.begin();
  await assert.rejects(limited.record(new AbortController().signal), recorderError('recording_limit'));

  const wrongFinal = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  wrongFinal.finalSampleAt = '2026-10-07T00:00:01.000Z';
  const invalidFinal = new MonitorRecorder({ client: wrongFinal, sink: new MemorySink() });
  await invalidFinal.begin();
  await assert.rejects(invalidFinal.seal('2026-10-07T00:00:02.000Z'), recorderError('invalid_stream'));

  const unsealed = new FakeClient([frame(1, '2026-10-07T00:00:01.000Z')]);
  unsealed.returnUnsealedAfterSeal = true;
  const invalidReplay = new MonitorRecorder({ client: unsealed, sink: new MemorySink() });
  await invalidReplay.begin();
  await assert.rejects(invalidReplay.seal('2026-10-07T00:00:02.000Z'), recorderError('invalid_stream'));

  const replaced = new FakeClient([]);
  replaced.streamStartedAt = '2026-10-07T00:00:01.000Z';
  const replacedRecorder = new MonitorRecorder({
    client: replaced,
    sink: new MemorySink(),
    checkpoint: { startedAt, source: null, cursor: 0 },
  });
  await assert.rejects(replacedRecorder.begin(), recorderError('invalid_stream'));
});
