import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { MonitorClient, MonitorClientError } = require('/test/client.cjs');

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

async function waitForFrames(client) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = await client.read(0);
    if (page.frames.length > 0) return page;
    await delay(100);
  }
  assert.fail('Monitor did not produce a frame');
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
    const started = await client.start();
    const firstPage = await waitForFrames(client);
    const source = firstPage.frames[0].source;
    const cutoffAt = new Date().toISOString();
    const sealed = await client.seal(cutoffAt);
    const finalPage = await client.read(0, source);

    assert.equal(sealed.cutoffAt, cutoffAt);
    assert.equal(finalPage.sealed, true);
    assert.ok(finalPage.frames.length > 0);
    assert.equal(finalPage.nextSequence, finalPage.frames.at(-1).sequence);
    process.stdout.write(
      JSON.stringify({
        health,
        startedAt: started.startedAt,
        frameCount: finalPage.frames.length,
        nextSequence: finalPage.nextSequence,
        sealed: finalPage.sealed,
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
