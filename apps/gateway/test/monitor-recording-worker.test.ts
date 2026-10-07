import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MonitorFramePage } from '../src/monitor-client.js';
import type { MonitorChunkStore, StoredMonitorChunk } from '../src/monitor-chunk-store.js';
import type { ClosableMonitorRecordingClient } from '../src/monitor-recording-runner.js';
import {
  MonitorRecordingWorker,
  MonitorRecordingWorkerError,
  type MonitorRecordingWork,
  type MonitorRecordingWorkSource,
} from '../src/monitor-recording-worker.js';
import type { MonitorRecordingBatch, SealedMonitorRecording } from '../src/monitor-recorder.js';
import {
  MonitorRecordingStoreError,
  type ClaimedMonitorRecording,
  type MonitorRecorderLease,
  type MonitorRecordingLeaseStore,
  type MonitorRecordingState,
  type MonitorRecordingStateStore,
} from '../src/monitor-recording-store.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const startedAt = '2026-10-08T00:00:00.000Z';
const cutoffAt = '2026-10-08T00:00:05.000Z';
const work: MonitorRecordingWork = {
  sessionId,
  monitor: { host: '127.0.0.1', certificate: 'test certificate', secret: 'a'.repeat(43) },
};

function drainingState(): MonitorRecordingState {
  return {
    schemaVersion: 1,
    status: 'draining',
    recorderId: 'gateway-a',
    generation: 1,
    leaseExpiresAt: '2026-10-08T00:00:15.000Z',
    startedAt,
    source: null,
    cursor: 0,
    cutoffAt,
    drainDeadlineAt: '2026-10-08T00:00:30.000Z',
    sealed: null,
    reason: null,
    updatedAt: '2026-10-08T00:00:00.000Z',
    completedAt: null,
  };
}

class WorkSource implements MonitorRecordingWorkSource {
  calls = 0;

  constructor(
    private readonly controller: AbortController,
    private readonly first: MonitorRecordingWork,
  ) {}

  async next(): Promise<MonitorRecordingWork | null> {
    this.calls++;
    if (this.calls === 1) return this.first;
    this.controller.abort();
    return null;
  }
}

class SealedClient implements ClosableMonitorRecordingClient {
  closed = false;
  seals: string[] = [];

  async start(): Promise<{ startedAt: string }> {
    return { startedAt };
  }

  async read(after: number): Promise<MonitorFramePage> {
    return { frames: [], nextSequence: after, sealed: true };
  }

  async seal(value: string) {
    this.seals.push(value);
    return {
      cutoffAt: value,
      final: {
        type: 'metrics' as const,
        sample: { at: value, values: {} },
        counters: { totalRequests: 0, failedRequests: 0 },
        recovery: { state: 'failing' as const, sustainedSeconds: 0, requiredSeconds: 60 },
      },
    };
  }

  close(): void {
    this.closed = true;
  }
}

class WorkRecordingStore implements MonitorRecordingLeaseStore, MonitorRecordingStateStore {
  seals = 0;
  failClaim = false;

  async get(): Promise<MonitorRecordingState> {
    return drainingState();
  }

  async claim(): Promise<ClaimedMonitorRecording> {
    if (this.failClaim) throw new MonitorRecordingStoreError('lease_unavailable');
    return {
      lease: { sessionId, recorderId: 'gateway-a', generation: 1 },
      state: drainingState(),
    };
  }

  async renew(): Promise<MonitorRecordingState> {
    return drainingState();
  }

  async begin(): Promise<void> {}

  async append(_lease: MonitorRecorderLease, _actualStartedAt: string, _reference: StoredMonitorChunk): Promise<void> {}

  async seal(): Promise<void> {
    this.seals++;
  }
}

class WorkChunkStore implements MonitorChunkStore {
  async putLive(
    _actualSessionId: string,
    _generation: number,
    _value: MonitorRecordingBatch,
  ): Promise<StoredMonitorChunk> {
    throw new Error('Live upload was not expected');
  }

  async putSealed(
    actualSessionId: string,
    generation: number,
    value: SealedMonitorRecording,
  ): Promise<StoredMonitorChunk> {
    return {
      phase: 'sealed',
      objectKey: `sessions/${actualSessionId}/metrics/${generation}/sealed/empty.json`,
      sha256: 'a'.repeat(64),
      source: value.source,
      after: 0,
      nextSequence: value.cursor,
      frameCount: value.frames.length,
    };
  }
}

test('the worker consumes discovered work through the complete recording runner', async () => {
  const controller = new AbortController();
  const source = new WorkSource(controller, work);
  const store = new WorkRecordingStore();
  const client = new SealedClient();
  const worker = new MonitorRecordingWorker({
    recorderId: 'gateway-a',
    source,
    chunks: new WorkChunkStore(),
    recordings: store,
    createClient: () => client,
  });

  await worker.run(controller.signal);

  assert.equal(source.calls, 2);
  assert.deepEqual(client.seals, [cutoffAt]);
  assert.equal(store.seals, 1);
  assert.equal(client.closed, true);
});

test('the worker backs off after a claim conflict', async () => {
  const controller = new AbortController();
  const source = new WorkSource(controller, work);
  const store = new WorkRecordingStore();
  store.failClaim = true;
  const client = new SealedClient();
  const waits: number[] = [];
  const worker = new MonitorRecordingWorker({
    recorderId: 'gateway-a',
    source,
    chunks: new WorkChunkStore(),
    recordings: store,
    retryIntervalMs: 250,
    createClient: () => client,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      controller.abort();
    },
  });

  await worker.run(controller.signal);

  assert.deepEqual(waits, [250]);
  assert.equal(source.calls, 1);
  assert.equal(client.closed, true);
});

test('the worker rejects invalid retry timing and concurrent runs', async () => {
  const controller = new AbortController();
  const source = new WorkSource(controller, work);
  const options = {
    recorderId: 'gateway-a',
    source,
    chunks: new WorkChunkStore(),
    recordings: new WorkRecordingStore(),
    createClient: () => new SealedClient(),
  };
  assert.throws(
    () => new MonitorRecordingWorker({ ...options, retryIntervalMs: 0 }),
    (error: unknown) => error instanceof MonitorRecordingWorkerError && error.code === 'invalid_config',
  );

  const worker = new MonitorRecordingWorker({
    ...options,
    source: {
      next: async (signal) =>
        await new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        }),
    },
  });
  const first = worker.run(controller.signal);
  await assert.rejects(
    worker.run(controller.signal),
    (error: unknown) => error instanceof MonitorRecordingWorkerError && error.code === 'invalid_state',
  );
  controller.abort();
  await first;
});

test('the worker treats an abort reason from the work source as normal shutdown', async () => {
  const controller = new AbortController();
  const worker = new MonitorRecordingWorker({
    recorderId: 'gateway-a',
    source: {
      next: async (signal) =>
        await new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(signal.reason);
          if (signal.aborted) cancel();
          else signal.addEventListener('abort', cancel, { once: true });
        }),
    },
    chunks: new WorkChunkStore(),
    recordings: new WorkRecordingStore(),
    createClient: () => new SealedClient(),
  });
  const running = worker.run(controller.signal);
  controller.abort(new Error('shutdown'));

  await running;
});

test('the worker closes a new client when runner configuration is invalid', async () => {
  const controller = new AbortController();
  const source = new WorkSource(controller, work);
  const client = new SealedClient();
  const worker = new MonitorRecordingWorker({
    recorderId: 'gateway-a',
    source,
    chunks: new WorkChunkStore(),
    recordings: new WorkRecordingStore(),
    leaseDurationMs: 5_000,
    renewalIntervalMs: 4_000,
    createClient: () => client,
  });

  await assert.rejects(
    worker.run(controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'MonitorRecordingRunnerError',
  );
  assert.equal(client.closed, true);
});
