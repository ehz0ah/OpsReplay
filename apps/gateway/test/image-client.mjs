import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { MonitorClient, MonitorClientError, MonitorRecorder, MonitorRecordingRunner } = require('/test/client.cjs');

class MemoryRecordingSink {
  startedAt = null;
  source = null;
  cursor = 0;
  frames = [];
  beginCount = 0;
  sealed = null;
  waiters = [];

  async begin(value) {
    if (this.startedAt === null) this.startedAt = value.startedAt;
    else assert.equal(value.startedAt, this.startedAt);
    this.beginCount++;
  }

  async append(value) {
    assert.equal(value.startedAt, this.startedAt);
    assert.equal(value.after, this.cursor);
    assert.ok(value.frames.length > 0);
    assert.equal(value.frames[0].sequence, this.cursor + 1);
    assert.equal(value.frames.at(-1).sequence, value.nextSequence);
    if (this.source !== null) assert.equal(value.source, this.source);
    this.source = value.source;
    this.cursor = value.nextSequence;
    this.frames.push(...structuredClone(value.frames));
    this.waiters.shift()?.();
  }

  async seal(value) {
    assert.equal(value.startedAt, this.startedAt);
    this.source = value.source;
    this.cursor = value.cursor;
    this.frames = structuredClone(value.frames);
    this.sealed = structuredClone(value);
  }

  nextAppend() {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class RunnerRecordingStore {
  constructor(state) {
    this.state = structuredClone(state);
    this.sealCount = 0;
  }

  async get() {
    return structuredClone(this.state);
  }

  async claim(value) {
    assert.equal(value.sessionId, this.state.sessionId);
    this.state.recorderId = value.recorderId;
    return {
      lease: { sessionId: value.sessionId, recorderId: value.recorderId, generation: this.state.generation },
      state: structuredClone(this.state),
    };
  }

  async renew() {
    return structuredClone(this.state);
  }

  async begin() {
    assert.fail('A resumed recording must not begin durable state again');
  }

  async append() {
    assert.fail('A draining recording must not append a live page');
  }

  async seal(_lease, value, reference) {
    assert.equal(value.cutoffAt, this.state.cutoffAt);
    assert.equal(reference.phase, 'sealed');
    this.sealCount++;
    this.state.status = 'complete';
  }
}

class RunnerChunkStore {
  async putLive() {
    assert.fail('A draining recording must not upload a live page');
  }

  async putSealed(sessionId, generation, value) {
    return {
      phase: 'sealed',
      objectKey: `sessions/${sessionId}/metrics/${generation}/sealed/test.json`,
      sha256: 'a'.repeat(64),
      source: value.source,
      after: 0,
      nextSequence: value.cursor,
      frameCount: value.frames.length,
    };
  }
}

function environment(name) {
  const value = process.env[name];
  assert.ok(value, `Missing ${name}`);
  return value;
}

async function waitUntilReady(client) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await client.health();
    if (health === 'ready') return health;
    assert.notEqual(health, 'failed', 'Monitor failed during initial checks');
    await delay(100);
  }
  assert.fail('Monitor did not become ready');
}

async function main() {
  const client = new MonitorClient({
    host: '127.0.0.1',
    certificate: Buffer.from(environment('OPSREPLAY_MONITOR_CA_B64'), 'base64'),
    secret: environment('OPSREPLAY_MONITOR_SECRET'),
  });
  try {
    if (process.env.OPSREPLAY_EXPECT_TLS_FAILURE === '1') {
      await assert.rejects(client.health(), (error) => {
        assert.ok(error instanceof MonitorClientError);
        assert.equal(error.code, 'tls_failed');
        return true;
      });
      process.stdout.write(JSON.stringify({ error: 'tls_failed' }) + '\n');
      return;
    }

    const health = await waitUntilReady(client);
    const sink = new MemoryRecordingSink();
    const firstRecorder = new MonitorRecorder({ client, sink, pollIntervalMs: 100 });
    const started = await firstRecorder.begin();
    const firstAppend = sink.nextAppend();
    const firstController = new AbortController();
    const firstRun = firstRecorder.record(firstController.signal);
    await firstAppend;
    firstController.abort();
    await firstRun;
    const firstCheckpoint = firstRecorder.checkpoint;

    const resumedRecorder = new MonitorRecorder({
      client,
      sink,
      checkpoint: firstCheckpoint,
      pollIntervalMs: 100,
    });
    assert.deepEqual(await resumedRecorder.begin(), started);
    const resumedAppend = sink.nextAppend();
    const resumedController = new AbortController();
    const resumedRun = resumedRecorder.record(resumedController.signal);
    await resumedAppend;
    resumedController.abort();
    await resumedRun;

    const cutoffAt = new Date().toISOString();
    const sealed = await resumedRecorder.seal(cutoffAt);

    assert.equal(sealed.cutoffAt, cutoffAt);
    assert.equal(sealed.final.sample.at, cutoffAt);
    assert.ok(sealed.frames.length >= 2);
    assert.equal(sealed.cursor, sealed.frames.at(-1).sequence);
    assert.deepEqual(sink.sealed, sealed);

    const runnerStore = new RunnerRecordingStore({
      sessionId: '11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      status: 'draining',
      recorderId: null,
      generation: 1,
      leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
      startedAt: sealed.startedAt,
      source: sealed.source,
      cursor: sealed.cursor,
      cutoffAt,
      drainDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
      sealed: null,
      reason: null,
      updatedAt: cutoffAt,
      completedAt: null,
    });
    const runnerResult = await new MonitorRecordingRunner({
      sessionId: runnerStore.state.sessionId,
      recorderId: 'gateway-image-test',
      client,
      chunks: new RunnerChunkStore(),
      recordings: runnerStore,
      pollIntervalMs: 100,
    }).run(new AbortController().signal);

    process.stdout.write(
      JSON.stringify({
        health,
        startedAt: started.startedAt,
        beginCount: sink.beginCount,
        resumedFrom: firstCheckpoint.cursor,
        frameCount: sealed.frames.length,
        nextSequence: sealed.cursor,
        sealed: sink.sealed !== null,
        runnerStatus: runnerResult.status,
        runnerSealCount: runnerStore.sealCount,
      }) + '\n',
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  const code = error instanceof MonitorClientError ? error.code : 'test_failed';
  process.stderr.write(JSON.stringify({ error: code }) + '\n');
  process.exitCode = 1;
});
