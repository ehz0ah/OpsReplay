import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MonitorClientError, type MonitorFrame, type MonitorFramePage } from '../src/monitor-client.js';
import type { MonitorChunkStore, StoredMonitorChunk } from '../src/monitor-chunk-store.js';
import {
  MonitorRecordingRunner,
  MonitorRecordingRunnerError,
  type ClosableMonitorRecordingClient,
} from '../src/monitor-recording-runner.js';
import type { MonitorRecordingBatch, SealedMonitorRecording } from '../src/monitor-recorder.js';
import {
  MonitorRecordingStoreError,
  type ClaimedMonitorRecording,
  type ClaimMonitorRecording,
  type MonitorRecorderLease,
  type MonitorRecordingLeaseStore,
  type MonitorRecordingState,
  type MonitorRecordingStateStore,
} from '../src/monitor-recording-store.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const startedAt = '2026-10-08T00:00:00.000Z';
const cutoffAt = '2026-10-08T00:00:10.000Z';
const drainDeadlineAt = '2026-10-08T00:00:30.000Z';

function metric(at: string) {
  return {
    type: 'metrics' as const,
    sample: { at, values: { request_rate: 1 } },
    counters: { totalRequests: 1, failedRequests: 0 },
    recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
  };
}

function frame(sequence = 1, at = '2026-10-08T00:00:05.000Z'): MonitorFrame {
  return { source, sequence, recordedAt: at, payload: metric(at) };
}

function recordingState(overrides: Partial<MonitorRecordingState> = {}): MonitorRecordingState {
  return {
    schemaVersion: 1,
    status: 'recording',
    recorderId: 'gateway-a',
    generation: 1,
    leaseExpiresAt: '2026-10-08T00:00:15.000Z',
    startedAt: null,
    source: null,
    cursor: 0,
    cutoffAt: null,
    drainDeadlineAt: null,
    sealed: null,
    retainUntil: null,
    reason: null,
    updatedAt: '2026-10-08T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class GateWait {
  private pending: { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal }[] = [];

  readonly wait = (_milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }
      const item = {
        resolve: () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        reject,
        signal,
      };
      const abort = () => {
        this.pending = this.pending.filter((candidate) => candidate !== item);
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.push(item);
    });

  release(): void {
    const item = this.pending.shift();
    assert.ok(item, 'No pending renewal wait');
    item.resolve();
  }

  get count(): number {
    return this.pending.length;
  }
}

class FakeMonitorClient implements ClosableMonitorRecordingClient {
  closed = false;
  sealedAt: string | null = null;
  reads: { after: number; expectedSource: string | undefined }[] = [];
  liveFrames: MonitorFrame[];
  sealedFrames: MonitorFrame[];

  constructor(options: { liveFrames?: MonitorFrame[]; sealedFrames?: MonitorFrame[] } = {}) {
    this.liveFrames = options.liveFrames ?? [frame()];
    this.sealedFrames = options.sealedFrames ?? [frame()];
  }

  async start(): Promise<{ startedAt: string }> {
    return { startedAt };
  }

  async read(after: number, expectedSource?: string, signal?: AbortSignal): Promise<MonitorFramePage> {
    this.reads.push({ after, expectedSource });
    if (this.sealedAt !== null) {
      const frames = this.sealedFrames.filter((value) => value.sequence > after);
      return {
        nextSequence: frames.at(-1)?.sequence ?? after,
        frames: clone(frames),
        sealed: true,
      };
    }
    const frames = this.liveFrames.filter((value) => value.sequence > after);
    if (frames.length > 0) {
      return {
        nextSequence: frames.at(-1)!.sequence,
        frames: clone(frames),
        sealed: false,
      };
    }
    return await new Promise((_resolve, reject) => {
      const cancel = () => reject(new MonitorClientError('cancelled'));
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  async seal(value: string) {
    this.sealedAt = value;
    return { cutoffAt: value, final: metric(value) };
  }

  close(): void {
    this.closed = true;
  }
}

class BlockingSealClient extends FakeMonitorClient {
  private releaseSeal: (() => void) | undefined;
  private readonly markSealStarted: () => void;
  readonly sealStarted: Promise<void>;

  constructor() {
    super({ liveFrames: [], sealedFrames: [] });
    let started = () => {};
    this.sealStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    this.markSealStarted = started;
  }

  override async seal(value: string) {
    this.markSealStarted();
    await new Promise<void>((resolve) => {
      this.releaseSeal = resolve;
    });
    return await super.seal(value);
  }

  finishSeal(): void {
    assert.ok(this.releaseSeal, 'Seal did not start');
    this.releaseSeal();
  }
}

class MemoryChunkStore implements MonitorChunkStore {
  live: MonitorRecordingBatch[] = [];
  sealed: SealedMonitorRecording[] = [];

  async putLive(
    actualSessionId: string,
    generation: number,
    value: MonitorRecordingBatch,
  ): Promise<StoredMonitorChunk> {
    this.live.push(clone(value));
    return this.reference(actualSessionId, generation, 'live', value.source, value.after, value.nextSequence);
  }

  async putSealed(
    actualSessionId: string,
    generation: number,
    value: SealedMonitorRecording,
  ): Promise<StoredMonitorChunk> {
    this.sealed.push(clone(value));
    return this.reference(actualSessionId, generation, 'sealed', value.source, 0, value.cursor);
  }

  private reference(
    actualSessionId: string,
    generation: number,
    phase: 'live' | 'sealed',
    actualSource: string | null,
    after: number,
    nextSequence: number,
  ): StoredMonitorChunk {
    const frameCount = phase === 'live' ? nextSequence - after : nextSequence;
    return {
      phase,
      objectKey: `sessions/${actualSessionId}/metrics/${generation}/${phase}/${randomUUID()}.json`,
      sha256: 'a'.repeat(64),
      source: actualSource,
      after,
      nextSequence,
      frameCount,
    };
  }
}

class MemoryRecordingStore implements MonitorRecordingLeaseStore, MonitorRecordingStateStore {
  state: MonitorRecordingState | undefined;
  begins = 0;
  appends = 0;
  seals = 0;
  renews = 0;
  claimError: MonitorRecordingStoreError | null = null;
  renewError: Error | null = null;
  drainOnAppend = false;

  constructor(initial?: MonitorRecordingState) {
    this.state = initial === undefined ? undefined : clone(initial);
  }

  async get(): Promise<MonitorRecordingState | undefined> {
    return this.state === undefined ? undefined : clone(this.state);
  }

  async claim(value: ClaimMonitorRecording): Promise<ClaimedMonitorRecording> {
    if (this.claimError) throw this.claimError;
    if (this.state === undefined) {
      this.state = recordingState({ recorderId: value.recorderId });
    }
    return {
      lease: { sessionId: value.sessionId, recorderId: this.state.recorderId!, generation: this.state.generation },
      state: clone(this.state),
    };
  }

  async renew(): Promise<MonitorRecordingState> {
    this.renews++;
    if (this.renewError) throw this.renewError;
    assert.ok(this.state);
    return clone(this.state);
  }

  async begin(_lease: MonitorRecorderLease, actualStartedAt: string): Promise<void> {
    assert.ok(this.state);
    this.begins++;
    this.state.startedAt = actualStartedAt;
  }

  async append(_lease: MonitorRecorderLease, _actualStartedAt: string, reference: StoredMonitorChunk): Promise<void> {
    assert.ok(this.state);
    if (this.drainOnAppend) {
      this.enterDrain();
      throw new MonitorRecordingStoreError('recording_draining');
    }
    this.appends++;
    this.state.source = reference.source;
    this.state.cursor = reference.nextSequence;
  }

  async seal(
    _lease: MonitorRecorderLease,
    value: SealedMonitorRecording,
    reference: StoredMonitorChunk,
  ): Promise<void> {
    assert.ok(this.state);
    assert.equal(this.state.status, 'draining');
    assert.equal(value.cutoffAt, this.state.cutoffAt);
    this.seals++;
    this.state = {
      ...this.state,
      status: 'complete',
      recorderId: null,
      leaseExpiresAt: null,
      source: reference.source,
      cursor: reference.nextSequence,
      sealed: clone(reference),
      retainUntil: '2026-11-07T00:00:10.000Z',
      completedAt: cutoffAt,
    };
  }

  enterDrain(): void {
    assert.ok(this.state);
    this.state = { ...this.state, status: 'draining', cutoffAt, drainDeadlineAt };
  }
}

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function runner(
  client: FakeMonitorClient,
  store: MemoryRecordingStore,
  chunks: MemoryChunkStore,
  gate: GateWait,
): MonitorRecordingRunner {
  return new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    chunks,
    recordings: store,
    leaseDurationMs: 5_000,
    renewalIntervalMs: 1_000,
    pollIntervalMs: 50,
    now: () => '2026-10-08T00:00:01.000Z',
    wait: gate.wait,
  });
}

test('records, observes the drain through lease renewal, and seals at the saved cutoff', async () => {
  const client = new FakeMonitorClient();
  const store = new MemoryRecordingStore();
  const chunks = new MemoryChunkStore();
  const gate = new GateWait();
  const running = runner(client, store, chunks, gate).run(new AbortController().signal);

  await until(() => store.appends === 1 && gate.count === 1, 'Recording did not start');
  store.enterDrain();
  gate.release();

  assert.deepEqual(await running, { status: 'complete', generation: 1 });
  assert.equal(store.begins, 1);
  assert.equal(store.seals, 1);
  assert.equal(client.sealedAt, cutoffAt);
  assert.equal(chunks.live.length, 1);
  assert.equal(chunks.sealed.length, 1);
  assert.equal(client.closed, true);
});

test('observes draining and seals an idle monitor stream', async () => {
  const client = new FakeMonitorClient({ liveFrames: [], sealedFrames: [] });
  const store = new MemoryRecordingStore();
  const chunks = new MemoryChunkStore();
  const gate = new GateWait();
  const running = runner(client, store, chunks, gate).run(new AbortController().signal);

  await until(() => client.reads.length === 1 && gate.count === 1, 'Idle recording did not start');
  store.enterDrain();
  gate.release();

  assert.deepEqual(await running, { status: 'complete', generation: 1 });
  assert.equal(store.appends, 0);
  assert.equal(chunks.sealed[0]?.cursor, 0);
  assert.equal(client.closed, true);
});

test('resumes from the saved cursor without beginning the durable stream again', async () => {
  const client = new FakeMonitorClient({ liveFrames: [frame(2, '2026-10-08T00:00:06.000Z')] });
  const store = new MemoryRecordingStore(recordingState({ startedAt, source, cursor: 1 }));
  const chunks = new MemoryChunkStore();
  const gate = new GateWait();
  const running = runner(client, store, chunks, gate).run(new AbortController().signal);

  await until(() => store.appends === 1 && gate.count === 1, 'Resumed recording did not append');
  store.enterDrain();
  gate.release();

  assert.equal((await running).status, 'complete');
  assert.equal(store.begins, 0);
  assert.deepEqual(client.reads[0], { after: 1, expectedSource: source });
});

test('uses the append race as a drain signal instead of treating it as a failure', async () => {
  const client = new FakeMonitorClient();
  const store = new MemoryRecordingStore();
  store.drainOnAppend = true;
  const chunks = new MemoryChunkStore();
  const gate = new GateWait();

  assert.equal((await runner(client, store, chunks, gate).run(new AbortController().signal)).status, 'complete');
  assert.equal(store.seals, 1);
  assert.equal(client.sealedAt, cutoffAt);
});

test('continues renewing the lease until a slow seal completes', async () => {
  const client = new BlockingSealClient();
  const store = new MemoryRecordingStore(
    recordingState({
      status: 'draining',
      startedAt,
      cutoffAt,
      drainDeadlineAt,
    }),
  );
  const gate = new GateWait();
  const running = runner(client, store, new MemoryChunkStore(), gate).run(new AbortController().signal);

  await client.sealStarted;
  await until(() => gate.count === 1, 'Renewal timer was not active during sealing');
  gate.release();
  await until(() => store.renews === 1, 'Lease was not renewed during sealing');
  client.finishSeal();

  assert.equal((await running).status, 'complete');
  assert.equal(store.seals, 1);
});

test('returns without recording when another gateway owns the lease', async () => {
  const client = new FakeMonitorClient();
  const store = new MemoryRecordingStore();
  store.claimError = new MonitorRecordingStoreError('lease_unavailable');
  const result = await runner(client, store, new MemoryChunkStore(), new GateWait()).run(new AbortController().signal);

  assert.deepEqual(result, { status: 'not_acquired', generation: null });
  assert.equal(client.reads.length, 0);
  assert.equal(client.closed, true);
});

test('reports a recording that cannot be claimed as not recordable', async () => {
  const client = new FakeMonitorClient();
  const store = new MemoryRecordingStore();
  store.claimError = new MonitorRecordingStoreError('invalid_state');
  const result = await runner(client, store, new MemoryChunkStore(), new GateWait()).run(new AbortController().signal);

  assert.deepEqual(result, { status: 'not_recordable', generation: null });
  assert.equal(client.reads.length, 0);
  assert.equal(client.closed, true);
});

test('stops the recorder when lease renewal loses ownership', async () => {
  const client = new FakeMonitorClient({ liveFrames: [] });
  const store = new MemoryRecordingStore();
  const gate = new GateWait();
  const running = runner(client, store, new MemoryChunkStore(), gate).run(new AbortController().signal);

  await until(() => client.reads.length === 1 && gate.count === 1, 'Recording did not reach its read loop');
  store.renewError = new MonitorRecordingStoreError('stale_lease');
  gate.release();

  assert.deepEqual(await running, { status: 'ownership_lost', generation: 1 });
  assert.equal(store.seals, 0);
  assert.equal(client.closed, true);
});

test('does not hide a conflicting durable state as ordinary lease loss', async () => {
  const client = new FakeMonitorClient({ liveFrames: [] });
  const store = new MemoryRecordingStore();
  const gate = new GateWait();
  const running = runner(client, store, new MemoryChunkStore(), gate).run(new AbortController().signal);

  await until(() => client.reads.length === 1 && gate.count === 1, 'Recording did not reach its read loop');
  store.renewError = new MonitorRecordingStoreError('invalid_state');
  gate.release();

  await assert.rejects(running, (error: unknown) => {
    return error instanceof MonitorRecordingStoreError && error.code === 'invalid_state';
  });
  assert.equal(client.closed, true);
});

test('fails closed when lease renewal cannot be confirmed', async () => {
  const client = new FakeMonitorClient({ liveFrames: [] });
  const store = new MemoryRecordingStore();
  const gate = new GateWait();
  const running = runner(client, store, new MemoryChunkStore(), gate).run(new AbortController().signal);

  await until(() => client.reads.length === 1 && gate.count === 1, 'Recording did not reach its read loop');
  store.renewError = new Error('DynamoDB unavailable');
  gate.release();

  await assert.rejects(running, /DynamoDB unavailable/);
  assert.equal(store.seals, 0);
  assert.equal(client.closed, true);
});

test('cancels pending monitor work and closes the client during shutdown', async () => {
  const client = new FakeMonitorClient({ liveFrames: [] });
  const store = new MemoryRecordingStore();
  const gate = new GateWait();
  const controller = new AbortController();
  const running = runner(client, store, new MemoryChunkStore(), gate).run(controller.signal);

  await until(() => client.reads.length === 1 && gate.count === 1, 'Recording did not reach its read loop');
  controller.abort();

  assert.deepEqual(await running, { status: 'cancelled', generation: 1 });
  assert.equal(store.seals, 0);
  assert.equal(client.closed, true);
});

test('rejects unsafe lease timing and concurrent use', async () => {
  const options = {
    sessionId,
    recorderId: 'gateway-a',
    client: new FakeMonitorClient({ liveFrames: [] }),
    chunks: new MemoryChunkStore(),
    recordings: new MemoryRecordingStore(),
    leaseDurationMs: 5_000,
    renewalIntervalMs: 5_000,
  };
  assert.throws(
    () => new MonitorRecordingRunner(options),
    (error: unknown) => error instanceof MonitorRecordingRunnerError && error.code === 'invalid_config',
  );
  assert.throws(
    () => new MonitorRecordingRunner({ ...options, renewalIntervalMs: 1_000, pollIntervalMs: 49 }),
    (error: unknown) => error instanceof MonitorRecordingRunnerError && error.code === 'invalid_config',
  );

  const gate = new GateWait();
  const active = runner(options.client, options.recordings, options.chunks, gate);
  const controller = new AbortController();
  const first = active.run(controller.signal);
  await until(() => options.client.reads.length === 1, 'Recording did not start');
  await assert.rejects(
    active.run(new AbortController().signal),
    (error: unknown) => error instanceof MonitorRecordingRunnerError && error.code === 'invalid_state',
  );
  controller.abort();
  assert.equal((await first).status, 'cancelled');
  await assert.rejects(
    active.run(new AbortController().signal),
    (error: unknown) => error instanceof MonitorRecordingRunnerError && error.code === 'invalid_state',
  );
});
