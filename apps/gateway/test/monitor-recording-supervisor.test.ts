import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { MonitorClientError } from '../src/monitor-client.js';
import { MonitorRecorderError } from '../src/monitor-recorder.js';
import {
  MonitorRecordingSupervisor,
  MonitorRecordingSupervisorError,
  type MonitorRecordingSupervisorEvent,
  type RecordingSessionRunner,
} from '../src/monitor-recording-supervisor.js';
import type { MonitorRecordingRunResult } from '../src/monitor-recording-runner.js';
import {
  RecordingWorkSourceError,
  type DiscoverRecordingWork,
  type RecordingWork,
  type RecordingWorkDiscovery,
  type RecordingWorkRetirement,
  type RecordingWorkSource,
} from '../src/recording-work-source.js';

function work(sessionId = randomUUID()): RecordingWork {
  return {
    sessionId,
    workOrder: `2026-10-08T00:00:00.000Z#SESSION#${sessionId}`,
    taskAddress: '10.0.1.42',
    monitorCertificate: 'certificate',
    monitorSecret: 's'.repeat(43),
  };
}

async function until(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

class MemoryWorkSource implements RecordingWorkSource {
  readonly retired: string[] = [];
  readonly discoveries: DiscoverRecordingWork[] = [];

  constructor(
    readonly work: RecordingWork[],
    readonly invalidEntries = 0,
    readonly retirement: RecordingWorkRetirement = 'retired',
  ) {}

  async discover(value: DiscoverRecordingWork): Promise<RecordingWorkDiscovery> {
    this.discoveries.push(structuredClone(value));
    const active = new Set(value.excludedSessionIds);
    return {
      work: this.work
        .filter((item) => !active.has(item.sessionId) && !this.retired.includes(item.sessionId))
        .slice(0, value.limit),
      invalidEntries: this.invalidEntries,
    };
  }

  async retire(value: { sessionId: string }): Promise<RecordingWorkRetirement> {
    if (this.retirement === 'retired') this.retired.push(value.sessionId);
    return this.retirement;
  }
}

class ControlledRunner implements RecordingSessionRunner {
  private resolve: ((value: MonitorRecordingRunResult) => void) | undefined;
  private reject: ((error: unknown) => void) | undefined;
  started = false;
  closed = false;

  async run(signal: AbortSignal): Promise<MonitorRecordingRunResult> {
    this.started = true;
    try {
      return await new Promise<MonitorRecordingRunResult>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
        const cancel = () => resolve({ status: 'cancelled', generation: 1 });
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
      });
    } finally {
      this.closed = true;
    }
  }

  finish(status: MonitorRecordingRunResult['status'] = 'complete'): void {
    assert.ok(this.resolve, 'Runner did not start');
    this.resolve({ status, generation: status === 'not_acquired' || status === 'not_recordable' ? null : 1 });
  }

  fail(error: unknown): void {
    assert.ok(this.reject, 'Runner did not start');
    this.reject(error);
  }
}

function supervisor(
  source: RecordingWorkSource,
  runners: Map<string, ControlledRunner[]>,
  options: {
    concurrency?: number;
    now?: () => number;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    events?: MonitorRecordingSupervisorEvent[];
  } = {},
): MonitorRecordingSupervisor {
  return new MonitorRecordingSupervisor({
    source,
    maximumConcurrentRecordings: options.concurrency ?? 2,
    pollIntervalMs: 100,
    retryDelayMs: 100,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
    ...(options.events === undefined ? {} : { report: (event) => options.events!.push(event) }),
    createRunner: (item) => {
      const runner = new ControlledRunner();
      const existing = runners.get(item.sessionId) ?? [];
      existing.push(runner);
      runners.set(item.sessionId, existing);
      return runner;
    },
  });
}

test('runs sessions concurrently up to the cap and never duplicates active work', async () => {
  const items = [work(), work(), work()];
  const source = new MemoryWorkSource(items);
  const runners = new Map<string, ControlledRunner[]>();
  const controller = new AbortController();
  const running = supervisor(source, runners).run(controller.signal);

  await until(() => runners.size === 2, 'The first two recording slots did not start');
  assert.equal([...runners.values()].flat().length, 2);
  assert.equal(source.discoveries.at(-1)?.excludedSessionIds.length, 0);

  runners.get(items[0]!.sessionId)![0]!.finish();
  await until(() => runners.has(items[2]!.sessionId), 'A released slot was not filled');
  assert.equal(runners.get(items[1]!.sessionId)?.length, 1);
  assert.equal(Math.max(...source.discoveries.map((value) => value.excludedSessionIds.length)), 1);

  controller.abort();
  await running;
  assert.ok([...runners.values()].flat().every((runner) => runner.closed));
});

test('isolates an operational session failure and keeps unrelated recording active', async () => {
  const items = [work(), work()];
  const source = new MemoryWorkSource(items);
  const runners = new Map<string, ControlledRunner[]>();
  const events: MonitorRecordingSupervisorEvent[] = [];
  const controller = new AbortController();
  const running = supervisor(source, runners, { events }).run(controller.signal);

  await until(() => runners.size === 2, 'Both recording slots did not start');
  runners.get(items[0]!.sessionId)![0]!.fail(new MonitorClientError('transport_failed'));
  await until(
    () => events.some((event) => event.type === 'runner_failed' && event.sessionId === items[0]!.sessionId),
    'Operational failure was not reported',
  );
  assert.equal(runners.get(items[1]!.sessionId)![0]!.closed, false);
  runners.get(items[1]!.sessionId)![0]!.finish();
  await until(() => source.retired.includes(items[1]!.sessionId), 'Healthy recording was not retired');

  controller.abort();
  await running;
});

test('isolates an invalid monitor stream without stopping unrelated recording', async () => {
  const items = [work(), work()];
  const source = new MemoryWorkSource(items);
  const runners = new Map<string, ControlledRunner[]>();
  const events: MonitorRecordingSupervisorEvent[] = [];
  const controller = new AbortController();
  const running = supervisor(source, runners, { events }).run(controller.signal);

  await until(() => runners.size === 2, 'Both recording slots did not start');
  runners.get(items[0]!.sessionId)![0]!.fail(new MonitorRecorderError('invalid_stream'));
  await until(
    () => events.some((event) => event.type === 'runner_failed' && event.sessionId === items[0]!.sessionId),
    'Invalid monitor stream was not isolated',
  );
  assert.equal(runners.get(items[1]!.sessionId)![0]!.closed, false);

  controller.abort();
  await running;
});

test('reports invalid work entries without blocking valid work from the same discovery', async () => {
  const item = work();
  const source = new MemoryWorkSource([item], 1);
  const runners = new Map<string, ControlledRunner[]>();
  const events: MonitorRecordingSupervisorEvent[] = [];
  const controller = new AbortController();
  const running = supervisor(source, runners, { events }).run(controller.signal);

  await until(() => runners.has(item.sessionId), 'Valid work did not start');
  assert.ok(events.some((event) => event.type === 'source_invalid' && event.invalidEntries === 1));

  controller.abort();
  await running;
});

test('retries an incomplete batch read without stopping the supervisor', async () => {
  const item = work();
  let attempts = 0;
  const source: RecordingWorkSource = {
    discover: async () => {
      attempts++;
      if (attempts === 1) throw new RecordingWorkSourceError('unavailable');
      return { work: [item], invalidEntries: 0 };
    },
    retire: async () => 'retired',
  };
  const runners = new Map<string, ControlledRunner[]>();
  const events: MonitorRecordingSupervisorEvent[] = [];
  const controller = new AbortController();
  const running = supervisor(source, runners, {
    events,
    wait: async (_milliseconds, signal) => {
      signal.throwIfAborted();
      await new Promise((resolve) => setImmediate(resolve));
    },
  }).run(controller.signal);

  await until(() => runners.has(item.sessionId), 'Work was not retried after the incomplete read');
  assert.ok(events.some((event) => event.type === 'source_failed' && event.error.code === 'unavailable'));
  runners.get(item.sessionId)![0]!.finish();
  controller.abort();
  await running;
});

test('isolates transient AWS failures but stops on AWS permission failures', async () => {
  const transientItems = [work(), work()];
  const transientSource = new MemoryWorkSource(transientItems);
  const transientRunners = new Map<string, ControlledRunner[]>();
  const transientEvents: MonitorRecordingSupervisorEvent[] = [];
  const transientController = new AbortController();
  const transientRun = supervisor(transientSource, transientRunners, { events: transientEvents }).run(
    transientController.signal,
  );

  await until(() => transientRunners.size === 2, 'Transient-failure runners did not start');
  const throttled = Object.assign(new Error('throttled'), {
    name: 'ThrottlingException',
    $metadata: { httpStatusCode: 400 },
    $retryable: { throttling: true },
  });
  transientRunners.get(transientItems[0]!.sessionId)![0]!.fail(throttled);
  await until(
    () => transientEvents.some((event) => event.type === 'runner_failed'),
    'Transient AWS failure was not isolated',
  );
  assert.equal(transientRunners.get(transientItems[1]!.sessionId)![0]!.closed, false);
  transientController.abort();
  await transientRun;

  const fatalItems = [work(), work()];
  const fatalSource = new MemoryWorkSource(fatalItems);
  const fatalRunners = new Map<string, ControlledRunner[]>();
  const fatalRun = supervisor(fatalSource, fatalRunners).run(new AbortController().signal);
  await until(() => fatalRunners.size === 2, 'Permission-failure runners did not start');
  const denied = Object.assign(new Error('denied'), {
    name: 'AccessDeniedException',
    $metadata: { httpStatusCode: 403 },
  });
  fatalRunners.get(fatalItems[0]!.sessionId)![0]!.fail(denied);

  await until(() => fatalRunners.get(fatalItems[0]!.sessionId)![0]!.closed, 'Permission failure did not close');
  assert.equal(fatalRunners.get(fatalItems[1]!.sessionId)![0]!.closed, false);
  fatalRunners.get(fatalItems[1]!.sessionId)![0]!.finish();
  await assert.rejects(fatalRun, (error: unknown) => error === denied);
  assert.equal(fatalRunners.get(fatalItems[1]!.sessionId)![0]!.closed, true);
});

test('retries lease contention after the bounded cooldown', async () => {
  const item = work();
  const source = new MemoryWorkSource([item]);
  const runners = new Map<string, ControlledRunner[]>();
  let now = Date.parse('2026-10-08T00:00:00.000Z');
  const controller = new AbortController();
  const running = supervisor(source, runners, {
    concurrency: 1,
    now: () => now,
    wait: async (_milliseconds, signal) => {
      signal.throwIfAborted();
      now += 100;
      await new Promise((resolve) => setImmediate(resolve));
    },
  }).run(controller.signal);

  await until(() => (runners.get(item.sessionId)?.length ?? 0) === 1, 'First claim did not start');
  runners.get(item.sessionId)![0]!.finish('not_acquired');
  await until(() => (runners.get(item.sessionId)?.length ?? 0) === 2, 'Contended work was not retried');
  runners.get(item.sessionId)![1]!.finish();
  await until(() => source.retired.includes(item.sessionId), 'Completed retry was not retired');

  controller.abort();
  await running;
});

test('retries completed work when authoritative state is not terminal yet', async () => {
  const item = work();
  const source = new MemoryWorkSource([item], 0, 'not_terminal');
  const runners = new Map<string, ControlledRunner[]>();
  let now = Date.parse('2026-10-08T00:00:00.000Z');
  const controller = new AbortController();
  const running = supervisor(source, runners, {
    concurrency: 1,
    now: () => now,
    wait: async (_milliseconds, signal) => {
      signal.throwIfAborted();
      now += 100;
      await new Promise((resolve) => setImmediate(resolve));
    },
  }).run(controller.signal);

  await until(() => (runners.get(item.sessionId)?.length ?? 0) === 1, 'First runner did not start');
  runners.get(item.sessionId)![0]!.finish();
  await until(() => (runners.get(item.sessionId)?.length ?? 0) === 2, 'Non-terminal work was not retried');

  controller.abort();
  await running;
});

test('stops new launches after a programming failure and lets healthy runners finish', async () => {
  const items = [work(), work(), work()];
  const source = new MemoryWorkSource(items);
  const runners = new Map<string, ControlledRunner[]>();
  const running = supervisor(source, runners).run(new AbortController().signal);

  await until(() => runners.size === 2, 'Both recording slots did not start');
  const failure = new TypeError('programming failure');
  runners.get(items[0]!.sessionId)![0]!.fail(failure);
  await until(() => runners.get(items[0]!.sessionId)![0]!.closed, 'Failed recording did not close');
  assert.equal(runners.get(items[1]!.sessionId)![0]!.closed, false);
  assert.equal(runners.has(items[2]!.sessionId), false);

  runners.get(items[1]!.sessionId)![0]!.finish();
  await assert.rejects(running, (error: unknown) => error === failure);
  assert.equal(runners.get(items[1]!.sessionId)![0]!.closed, true);
});

test('does not construct more runners after a fatal factory failure', async () => {
  const items = [work(), work()];
  const constructed: string[] = [];
  const failure = new TypeError('factory failure');
  const service = new MonitorRecordingSupervisor({
    source: new MemoryWorkSource(items),
    maximumConcurrentRecordings: 2,
    pollIntervalMs: 100,
    createRunner: (item) => {
      constructed.push(item.sessionId);
      if (item.sessionId === items[0]!.sessionId) throw failure;
      return new ControlledRunner();
    },
  });

  await assert.rejects(service.run(new AbortController().signal), (error: unknown) => error === failure);
  assert.deepEqual(constructed, [items[0]!.sessionId]);
});

test('shutdown cancels all active runners and a supervisor cannot restart', async () => {
  const items = [work(), work()];
  const source = new MemoryWorkSource(items);
  const runners = new Map<string, ControlledRunner[]>();
  const controller = new AbortController();
  const service = supervisor(source, runners);
  const running = service.run(controller.signal);

  await until(() => runners.size === 2, 'Both recording slots did not start');
  controller.abort();
  await running;
  assert.ok([...runners.values()].flat().every((runner) => runner.closed));
  await assert.rejects(
    service.run(new AbortController().signal),
    (error: unknown) => error instanceof MonitorRecordingSupervisorError && error.code === 'invalid_state',
  );
});

test('rejects unsafe capacity and retry timing before discovery', () => {
  const source = new MemoryWorkSource([]);
  const runners = new Map<string, ControlledRunner[]>();
  for (const options of [
    { maximumConcurrentRecordings: 0 },
    { maximumConcurrentRecordings: 65 },
    { maximumConcurrentRecordings: 1, pollIntervalMs: 99 },
    { maximumConcurrentRecordings: 1, pollIntervalMs: 1_000, retryDelayMs: 999 },
  ]) {
    assert.throws(
      () =>
        new MonitorRecordingSupervisor({
          source,
          createRunner: () => new ControlledRunner(),
          ...options,
        }),
      (error: unknown) => error instanceof MonitorRecordingSupervisorError && error.code === 'invalid_config',
    );
  }
  assert.equal(runners.size, 0);
});

test('bounds retry cooldown tracking and pauses discovery instead of evicting live cooldowns', async () => {
  const source = new MemoryWorkSource(Array.from({ length: 6 }, () => work()));
  const controller = new AbortController();
  let attempts = 0;
  let waits = 0;
  const service = new MonitorRecordingSupervisor({
    source,
    maximumConcurrentRecordings: 2,
    pollIntervalMs: 100,
    retryDelayMs: 30_000,
    now: () => Date.parse('2026-10-08T00:00:00.000Z'),
    wait: async (_milliseconds, signal) => {
      signal.throwIfAborted();
      waits++;
      if (attempts >= 3 && waits >= 10) controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
    },
    createRunner: () => ({
      run: async () => {
        attempts++;
        return { status: 'not_acquired', generation: null };
      },
    }),
  });

  await service.run(controller.signal);

  assert.ok(attempts >= 3 && attempts <= 4);
  assert.ok(source.discoveries.every((value) => value.excludedSessionIds.length <= 4));
});
