import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../../../content/challenges/wrong-upstream-port/challenge.json';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';
import type { HttpResponse, Transport } from '../src/types.js';

function fixture() {
  let at = Date.parse('2026-10-06T00:00:00Z');
  const state = { healthy: false, probeUp: true, requests: 0, holdCheckout: false, crash: false, hang: false };
  const orders = new Map<string, object>();
  let release: (() => void) | undefined;
  const transport: Transport = {
    async http(check, signal, json) {
      state.requests++;
      if (state.crash) throw new Error('private-platform-error');
      if (state.hang) return new Promise(resolve => {
        if (signal.aborted) resolve(null);
        else signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      if (!state.healthy) return { status: 502, body: 'private-untrusted-body' };
      const result: HttpResponse = { status: 200, body: '{}' };
      if (check.method === 'POST') {
        const order = { id: 'order-1', reference: (json as { reference?: string } | undefined)?.reference ?? 'traffic', status: 'confirmed' };
        if (json) orders.set('order-1', order);
        result.status = 201;
        result.body = JSON.stringify(order);
      } else if (check.url.includes('/api/orders/')) result.body = JSON.stringify(orders.get('order-1'));
      if (state.holdCheckout && json) {
        state.holdCheckout = false;
        return new Promise(resolve => { release = () => resolve(result); });
      }
      return result;
    },
    async tcp() { return state.probeUp; },
  };
  const monitor = new Monitor(parseConfig(JSON.stringify(manifest)), transport, { now: () => at });
  return { monitor, state, release: () => release?.(),
    advance: async (ms: number) => { at += ms; monitor.tick(); await monitor.drain(); },
    jump: (ms: number) => { at += ms; },
  };
}

test('startup requires the fault and healthy probes, and warm-up is excluded', async () => {
  const f = fixture();
  assert.throws(() => f.monitor.start(), /initial_state_failed/);
  f.state.probeUp = false;
  assert.equal(await f.monitor.verifyInitialState(), false);
  f.state.probeUp = true;
  f.state.healthy = true;
  assert.equal(await f.monitor.verifyInitialState(), false);
  f.state.healthy = false;
  assert.equal(await f.monitor.verifyInitialState(), true);
  assert.ok(f.state.requests > 0);
  const at = f.monitor.start();
  assert.equal(f.monitor.start(), at);
  assert.deepEqual((await f.monitor.snapshot()).counters, { totalRequests: 0, failedRequests: 0 });
  await f.advance(0);
  assert.deepEqual((await f.monitor.snapshot()).counters, { totalRequests: 1, failedRequests: 1 });
  assert.ok(!JSON.stringify(f.monitor.read()).includes('private-untrusted-body'));
  await f.monitor.seal();
});

test('a monitor exception stops the run and never becomes a shop failure or recovery', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  f.state.crash = true;
  await f.advance(0);
  assert.equal(f.monitor.failure, 'monitor_failed');
  assert.ok(!JSON.stringify(f.monitor.read()).includes('private-platform-error'));
  await assert.rejects(f.monitor.seal(), /^MonitorError: monitor_failed$/);
});

test('sealing cancels unfinished transport work and does not count cancelled attempts', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  f.state.hang = true;
  f.monitor.tick();
  await new Promise(resolve => setImmediate(resolve));
  const result = await f.monitor.seal();
  assert.deepEqual(result.counters, { totalRequests: 0, failedRequests: 0 });
  assert.equal(result.recovery.state, 'failing');
  assert.equal(f.monitor.failure, null);
});

test('healthy checkout needs the complete sustain window and emits recovery once', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  f.state.healthy = true;
  await f.advance(0);
  for (let i = 0; i < 119; i++) await f.advance(500);
  assert.equal((await f.monitor.snapshot()).recovery.state, 'sustaining');
  await f.advance(500);
  assert.equal((await f.monitor.snapshot()).recovery.state, 'met');
  await f.advance(500);
  const events = f.monitor.read().filter(f => f.payload.type === 'timeline' && f.payload.event.signal === 'recovered');
  assert.equal(events.length, 1);
  assert.equal((await f.monitor.snapshot()).counters.failedRequests, 0);
  await f.monitor.seal();
});

test('a slow passing validator is not invalidated while it is still running', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  f.state.healthy = true;
  f.state.holdCheckout = true;
  f.monitor.tick();
  await new Promise(resolve => setImmediate(resolve));
  f.jump(500);
  f.monitor.tick();
  f.jump(500);
  f.monitor.tick();
  f.release();
  await f.monitor.drain();
  assert.equal((await f.monitor.snapshot()).recovery.state, 'sustaining');
  assert.equal(f.monitor.read().filter(frame => frame.payload.type === 'timeline'
    && frame.payload.event.signal === 'recovery_lost').length, 0);
  await f.monitor.seal();
});

test('a missed validator slot resets recovery when no check was running', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  f.state.healthy = true;
  await f.advance(0);
  assert.equal(f.monitor.snapshot().recovery.state, 'sustaining');
  await f.advance(2500);
  assert.equal(f.monitor.snapshot().recovery.state, 'sustaining');
  assert.equal(f.monitor.snapshot().recovery.sustainedSeconds, 0);
  assert.equal(f.monitor.read().filter(frame => frame.payload.type === 'timeline'
    && frame.payload.event.signal === 'recovery_lost').length, 1);
  await f.monitor.seal();
});

test('a short scheduler gap resumes without a burst, but a five-second gap fails', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  await f.advance(0);
  await f.advance(1501);
  assert.equal(f.monitor.failure, null);
  assert.equal(f.monitor.snapshot().counters.totalRequests, 2);
  await f.advance(6000);
  assert.equal(f.monitor.failure, 'schedule_gap');
  assert.equal(f.monitor.stopped, true);
  assert.throws(() => f.monitor.snapshot(), /schedule_gap/);
});

test('outages use the first failed probe time, honor grace, and end once', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  const start = f.monitor.start();
  f.state.probeUp = false;
  await f.advance(0);
  for (let i = 0; i < 10; i++) await f.advance(500);
  for (let i = 0; i < 4; i++) await f.advance(500);
  const started = f.monitor.read().filter(f => f.payload.type === 'timeline' && f.payload.event.signal === 'outage_started');
  assert.equal(started.length, 1);
  assert.equal(started[0]!.payload.type === 'timeline' && started[0]!.payload.event.at, new Date(start).toISOString());
  f.state.probeUp = true;
  await f.advance(500);
  await f.advance(500);
  assert.equal(f.monitor.read().filter(f => f.payload.type === 'timeline' && f.payload.event.signal === 'outage_ended').length, 1);
  await f.monitor.seal();
});

test('sealing replays the fixed cutoff and excludes later counters and recovery', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  const start = f.monitor.start();
  await f.advance(0);
  const first = await f.monitor.snapshot();
  f.state.healthy = true;
  await f.advance(500);
  await f.advance(500);
  assert.equal((await f.monitor.snapshot()).counters.totalRequests, 5);
  const sealed = await f.monitor.seal(start);
  assert.deepEqual(sealed, first);
  sealed.counters.totalRequests = 999;
  assert.deepEqual(await f.monitor.seal(start), first);
  assert.throws(() => f.monitor.seal(start + 500), /invalid_boundary/);
  f.jump(500);
  f.monitor.tick();
  assert.deepEqual(await f.monitor.seal(), first);
  assert.deepEqual(await f.monitor.snapshot(start), first);
  assert.ok(f.monitor.read().every(frame => frame.recordedAt <= start));
  assert.throws(() => f.monitor.read(-1), /invalid_boundary/);
  const frames = f.monitor.read();
  frames.splice(0);
  assert.ok(f.monitor.read().length > 0);
});

test('a reserved cutoff hides later frames before sealing completes', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  const start = f.monitor.start();
  await f.advance(0);
  f.monitor.reserveCutoff(start);
  f.jump(5000);
  f.monitor.tick();
  await f.monitor.drain();
  assert.ok(f.monitor.read().every(frame => frame.recordedAt <= start));
  assert.deepEqual(await f.monitor.seal(start), await f.monitor.snapshot(start));
  assert.throws(() => f.monitor.reserveCutoff(start + 1), /invalid_boundary/);
});

test('sealing excludes an outage learned only after the cutoff', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  const start = f.monitor.start();
  f.state.probeUp = false;
  await f.advance(0);
  for (let i = 0; i < 10; i++) await f.advance(500);
  assert.ok(f.monitor.read().some(frame => frame.payload.type === 'timeline' && frame.payload.event.signal === 'outage_started'));
  await f.monitor.seal(start + 3000);
  assert.ok(!f.monitor.read().some(frame => frame.payload.type === 'timeline' && frame.payload.event.signal === 'outage_started'));
});

test('scheduled samples are appended before sealing with contiguous sequences', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  await f.advance(0);
  f.jump(5000);
  f.monitor.tick();
  await f.monitor.seal(f.monitor.now());
  const frames = f.monitor.read();
  assert.ok(frames.filter(frame => frame.payload.type === 'metrics').length >= 2);
  assert.deepEqual(frames.map(frame => frame.sequence), frames.map((_, index) => index + 1));
});

test('the authored Free limit does not stop a Pro-length recording or exact-cutoff seal', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  const start = f.monitor.start();
  await f.advance(0);
  for (let i = 0; i < 3600; i++) await f.advance(500);
  const proCutoff = start + 30 * 60_000;
  assert.equal(f.monitor.now(), proCutoff);
  assert.equal(f.monitor.failure, null);
  const final = await f.monitor.seal(proCutoff);
  assert.ok(final.counters.totalRequests > 0);
  assert.equal(f.monitor.failure, null);
});

test('pending work stays bounded when a transport fails to complete until cancellation', async () => {
  const f = fixture();
  await f.monitor.verifyInitialState();
  f.monitor.start();
  f.state.hang = true;
  // The fake transport ignores deadlines to exercise the core's independent limit.
  for (let i = 0; i < 40 && !f.monitor.stopped; i++) {
    f.monitor.tick();
    await new Promise(resolve => setImmediate(resolve));
    f.jump(500);
  }
  await f.monitor.drain();
  assert.equal(f.monitor.failure, 'traffic_capacity');
  assert.ok(f.state.requests < 40);
  await assert.rejects(f.monitor.seal(), /traffic_capacity/);
});
