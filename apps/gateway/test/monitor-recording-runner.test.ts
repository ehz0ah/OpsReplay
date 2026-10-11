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
  advanceTerminalCheckpoint,
  encodeTerminalPage,
  initialTerminalCheckpoint,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  encodeSealedTerminalPage,
  type TerminalSealState,
} from '../../../packages/contracts/private/terminal-sealing.js';
import { terminalPage, terminalReady } from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { TerminalRecordingStoreError } from '../src/terminal-recording-store.js';
import type { MonitorRecordingRunnerOptions } from '../src/monitor-recording-runner.js';
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

  async markIncomplete(_id: string, reason: string): Promise<void> {
    assert.ok(this.state);
    this.state = { ...this.state, status: 'incomplete', reason, recorderId: null, leaseExpiresAt: null };
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

function terminalFixture(): {
  options: NonNullable<MonitorRecordingRunnerOptions['terminal']>;
  checkpoint: () => TerminalRecordingCheckpoint | undefined;
  seal: () => TerminalSealState | undefined;
  connections: () => number;
} {
  const ready = terminalReady({ startedAt, observedAt: startedAt });
  const page = terminalPage(undefined, {
    startedAt,
    observedAt: '2026-10-08T00:00:11.000Z',
    events: [{ type: 'dimensions', sequence: 1, recordedAt: startedAt, columns: 80, rows: 24 }],
  });
  let checkpoint: TerminalRecordingCheckpoint | undefined;
  let sealed: TerminalSealState | undefined;
  let connections = 0;
  const options: NonNullable<MonitorRecordingRunnerOptions['terminal']> = {
    connect: async () => {
      connections++;
      return { ready, client: { read: async () => page, close: () => {} } };
    },
    chunks: {
      putPage: async (id, generation, after, value) => encodeTerminalPage(id, generation, after, value).reference,
    },
    recordings: {
      get: async () => checkpoint,
      begin: async () => {
        checkpoint ??= initialTerminalCheckpoint(ready);
        return checkpoint;
      },
      commit: async (_lease, previous, value) => {
        checkpoint = advanceTerminalCheckpoint(previous, value);
        return checkpoint;
      },
    },
    pages: {
      readLive: async () => page,
      putSealed: async (id, generation, source, after, events) =>
        encodeSealedTerminalPage(id, generation, source, after, events).reference,
    },
    seals: {
      get: async () => sealed,
      begin: async (_lease, value, cutoffAt) => {
        sealed ??= {
          schemaVersion: 1,
          cutoffAt,
          checkpoint: value,
          cursor: 0,
          pageCount: 0,
          recordedBytes: 0,
          lastAt: null,
          excludedAt: null,
          complete: false,
        };
        return sealed;
      },
      nextPage: async () => encodeTerminalPage(sessionId, 1, 0, page).reference,
      append: async (_lease, previous, reference, bytes) => {
        sealed = {
          ...previous,
          cursor: reference.nextSequence,
          pageCount: previous.pageCount + 1,
          recordedBytes: previous.recordedBytes + bytes,
          lastAt: reference.lastAt,
        };
        return sealed;
      },
      finish: async (_lease, previous, proof) => {
        const excludedAt =
          proof?.page.events.find((event) => event.sequence === previous.cursor + 1)?.recordedAt ?? null;
        sealed = { ...previous, excludedAt, complete: true };
        return sealed;
      },
    },
  };
  return { options, checkpoint: () => checkpoint, seal: () => sealed, connections: () => connections };
}

test('combined runner continues lease renewal while terminal seal waits and only then publishes completion', async () => {
  const terminal = terminalFixture();
  const client = new FakeMonitorClient({ liveFrames: [], sealedFrames: [] });
  const store = new MemoryRecordingStore();
  const gate = new GateWait();
  let markFinish = () => {};
  const finishStarted = new Promise<void>((resolve) => {
    markFinish = resolve;
  });
  let release = () => {};
  const finish = terminal.options.seals.finish;
  terminal.options.seals.finish = async (...args) => {
    markFinish();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return finish(...args);
  };
  const running = new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    recordings: store,
    chunks: new MemoryChunkStore(),
    terminal: terminal.options,
    leaseDurationMs: 5000,
    renewalIntervalMs: 1000,
    wait: gate.wait,
    now: () => '2026-10-08T00:00:11.000Z',
  }).run(new AbortController().signal);
  await until(
    () => terminal.checkpoint()?.cursor === 1 && client.reads.length > 0 && gate.count === 1,
    'Both collectors did not start',
  );
  store.enterDrain();
  gate.release();
  await finishStarted;
  assert.equal(client.sealedAt, cutoffAt);
  assert.equal(store.seals, 0);
  const renews = store.renews;
  gate.release();
  await until(() => store.renews > renews, 'Renewal stopped during terminal seal');
  release();
  assert.equal((await running).status, 'complete');
  assert.equal(terminal.seal()?.complete, true);
  assert.equal(store.seals, 1);
});

test('combined runner resumes an already durable drain without reconnecting terminal source', async () => {
  const terminal = terminalFixture();
  await terminal.options.recordings.begin(
    { sessionId, recorderId: 'gateway-a', generation: 1 },
    terminalReady(),
    startedAt,
  );
  const page = terminalPage(undefined, {
    startedAt,
    observedAt: '2026-10-08T00:00:11.000Z',
    events: [{ type: 'dimensions', sequence: 1, recordedAt: startedAt, columns: 80, rows: 24 }],
  });
  await terminal.options.recordings.commit(
    { sessionId, recorderId: 'gateway-a', generation: 1 },
    terminal.checkpoint()!,
    page,
    encodeTerminalPage(sessionId, 1, 0, page).reference,
    cutoffAt,
  );
  terminal.options.connect = async () => {
    throw new Error('Source must not be reopened');
  };
  const store = new MemoryRecordingStore(recordingState({ status: 'draining', startedAt, cutoffAt, drainDeadlineAt }));
  const result = await new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client: new FakeMonitorClient({ liveFrames: [], sealedFrames: [] }),
    chunks: new MemoryChunkStore(),
    recordings: store,
    terminal: terminal.options,
    wait: new GateWait().wait,
    now: () => '2026-10-08T00:00:11.000Z',
  }).run(new AbortController().signal);
  assert.equal(result.status, 'complete');
  assert.equal(terminal.connections(), 0);
  assert.equal(terminal.seal()?.complete, true);
});

test('covered takeover seals from storage without calling either stopped task source', async () => {
  const terminal = terminalFixture();
  const ready = terminalReady({ startedAt, observedAt: startedAt });
  await terminal.options.recordings.begin({ sessionId, recorderId: 'gateway-a', generation: 1 }, ready, startedAt);
  const page = terminalPage(undefined, {
    startedAt,
    observedAt: '2026-10-08T00:00:11.000Z',
    events: [{ type: 'dimensions', sequence: 1, recordedAt: startedAt, columns: 80, rows: 24 }],
  });
  await terminal.options.recordings.commit(
    { sessionId, recorderId: 'gateway-a', generation: 1 },
    terminal.checkpoint()!,
    page,
    encodeTerminalPage(sessionId, 1, 0, page).reference,
    cutoffAt,
  );
  terminal.options.connect = async () => {
    throw new Error('Stopped terminal must not be contacted');
  };
  const client = new FakeMonitorClient();
  client.start = async () => {
    throw new Error('Stopped Monitor must not be contacted');
  };
  const store = new MemoryRecordingStore(
    recordingState({
      status: 'draining',
      startedAt,
      cutoffAt,
      drainDeadlineAt: '2026-10-09T00:00:11.000Z',
      generation: 2,
    }),
  );
  let finishes = 0;
  const coverage = {
    schemaVersion: 1 as const,
    sessionId,
    cutoffAt,
    coveredAt: '2026-10-08T00:00:11.000Z',
    taskDrainDeadlineAt: drainDeadlineAt,
    sealingDeadlineAt: '2026-10-09T00:00:11.000Z',
    terminal: terminal.checkpoint()!,
    monitor: await new MemoryChunkStore().putSealed(sessionId, 1, {
      startedAt,
      cutoffAt,
      source: null,
      cursor: 0,
      frames: [],
      final: metric(cutoffAt),
    }),
    final: metric(cutoffAt),
  };
  const result = await new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    chunks: new MemoryChunkStore(),
    recordings: store,
    terminal: terminal.options,
    captures: {
      baseline: async () => {
        throw new Error('Stopped capture baseline must not be contacted');
      },
      collect: async () => {
        throw new Error('Stopped capture collection must not be contacted');
      },
      finish: async () => {
        throw new Error('Stopped final capture must not be contacted');
      },
    },
    coverage: {
      get: async () => coverage,
      commit: async () => {
        throw new Error('Coverage must not be repeated');
      },
      finish: async (lease, saved) => {
        assert.equal(lease.generation, 2);
        assert.equal(saved, coverage);
        finishes++;
      },
    },
    now: () => '2026-10-08T00:00:11.000Z',
    wait: new GateWait().wait,
  }).run(new AbortController().signal);
  assert.equal(result.status, 'complete');
  assert.equal(finishes, 1);
  assert.equal(terminal.seal()?.complete, true);
  assert.equal(client.closed, true);
});

test('terminal loss keeps Monitor collection alive and publishes incomplete once at cutoff', async () => {
  const terminal = terminalFixture();
  let reads = 0;
  let closes = 0;
  terminal.options.connect = async () => ({
    ready: terminalReady({ startedAt, observedAt: startedAt }),
    client: {
      read: async () => {
        reads++;
        return terminalPage(undefined, {
          startedAt,
          observedAt: '2026-10-08T00:00:06.000Z',
          events: [{ type: 'dimensions', sequence: 1, recordedAt: startedAt, columns: 80, rows: 24 }],
          loss: { reason: 'limit_exceeded', occurredAt: '2026-10-08T00:00:06.000Z' },
        });
      },
      close: () => {
        closes++;
      },
    },
  });
  const store = new MemoryRecordingStore();
  const client = new FakeMonitorClient();
  const gate = new GateWait();
  const running = new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    recordings: store,
    chunks: new MemoryChunkStore(),
    terminal: terminal.options,
    wait: gate.wait,
    now: () => '2026-10-08T00:00:11.000Z',
  }).run(new AbortController().signal);
  await until(() => store.appends === 1 && terminal.checkpoint()?.metadata.loss !== null, 'Streams did not advance');
  assert.equal(client.closed, false);
  store.enterDrain();
  gate.release();
  assert.equal((await running).status, 'incomplete');
  assert.equal(reads, 1);
  assert.ok(closes > 0);
  assert.equal(store.state?.reason, 'limit_exceeded');
  assert.equal(store.seals, 0);
  assert.equal(client.sealedAt, cutoffAt);
  terminal.options.connect = async () => {
    throw new Error('Lost source must not be reopened');
  };
  const replacement = new MemoryRecordingStore(
    recordingState({ status: 'draining', startedAt, cutoffAt, drainDeadlineAt }),
  );
  const resumed = await new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client: new FakeMonitorClient(),
    recordings: replacement,
    chunks: new MemoryChunkStore(),
    terminal: terminal.options,
    wait: new GateWait().wait,
    now: () => '2026-10-08T00:00:11.000Z',
  }).run(new AbortController().signal);
  assert.equal(resumed.status, 'incomplete');
  assert.equal(reads, 1);
});

test('lifecycle readiness follows both durable initial pages and precedes terminal polling', async () => {
  const terminal = terminalFixture();
  const client = new FakeMonitorClient();
  const store = new MemoryRecordingStore();
  const gate = new GateWait();
  const order: string[] = [];
  const commit = terminal.options.recordings.commit;
  terminal.options.recordings.commit = async (...args) => {
    order.push('terminal');
    return commit(...args);
  };
  const start = client.start.bind(client);
  client.start = async () => {
    order.push('start');
    return start();
  };
  let release = () => {};
  let readyStarted = false;
  const running = new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    chunks: new MemoryChunkStore(),
    recordings: store,
    terminal: terminal.options,
    lifecycle: {
      ready: async (_lease, actualStartedAt, checkpoint) => {
        order.push('ready');
        assert.equal(actualStartedAt, startedAt);
        assert.equal(checkpoint.cursor, 1);
        assert.equal(store.appends, 1);
        readyStarted = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      monitor: async () => {
        order.push('monitor');
      },
    },
    wait: gate.wait,
    now: () => '2026-10-08T00:00:11.000Z',
  }).run(new AbortController().signal);
  await until(() => readyStarted, 'Readiness callback did not start');
  assert.deepEqual(order, ['terminal', 'start', 'monitor', 'ready']);
  store.enterDrain();
  gate.release();
  await until(() => store.renews === 1, 'Drain was not observed during readiness');
  release();
  assert.equal((await running).status, 'complete');
  assert.equal(store.seals, 1);
  assert.equal(terminal.seal()?.complete, true);
});

test('readiness failure closes both sources without publishing recording completion', async () => {
  const terminal = terminalFixture();
  const client = new FakeMonitorClient();
  const store = new MemoryRecordingStore();
  const running = new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    chunks: new MemoryChunkStore(),
    recordings: store,
    terminal: terminal.options,
    lifecycle: {
      ready: async () => {
        throw new Error('Readiness write failed');
      },
      monitor: async () => {},
    },
    wait: new GateWait().wait,
    now: () => '2026-10-08T00:00:11.000Z',
  }).run(new AbortController().signal);
  await assert.rejects(running, /Readiness write failed/);
  assert.equal(terminal.checkpoint()?.cursor, 1);
  assert.equal(store.appends, 1);
  assert.equal(store.seals, 0);
  assert.equal(client.closed, true);
});

test('terminal failure cancels monitor work and cannot publish combined completion', async () => {
  const terminal = terminalFixture();
  terminal.options.recordings.commit = async () => {
    throw new TerminalRecordingStoreError('stale_lease');
  };
  const store = new MemoryRecordingStore();
  const client = new FakeMonitorClient({ liveFrames: [] });
  const result = await new MonitorRecordingRunner({
    sessionId,
    recorderId: 'gateway-a',
    client,
    chunks: new MemoryChunkStore(),
    recordings: store,
    terminal: terminal.options,
    wait: new GateWait().wait,
  }).run(new AbortController().signal);
  assert.equal(result.status, 'ownership_lost');
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
