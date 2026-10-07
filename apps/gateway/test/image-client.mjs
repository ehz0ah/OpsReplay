import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { MonitorClient, MonitorClientError, MonitorRecorder } = require('/test/client.cjs');

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
    process.stdout.write(
      JSON.stringify({
        health,
        startedAt: started.startedAt,
        beginCount: sink.beginCount,
        resumedFrom: firstCheckpoint.cursor,
        frameCount: sealed.frames.length,
        nextSequence: sealed.cursor,
        sealed: sink.sealed !== null,
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
