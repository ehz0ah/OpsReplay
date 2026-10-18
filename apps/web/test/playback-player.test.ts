import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackPlayer, type PlayerState } from '../src/playback/player.js';
import { TerminalRecording, terminalRange } from '../src/playback/terminal.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test('player advances through silent intervals, applies speed changes without jumping, and ends exactly', async () => {
  let now = 0;
  const positions: number[] = [],
    states: PlayerState[] = [];
  let control!: PlaybackPlayer;
  control = new PlaybackPlayer(
    { start: 1000, end: 1300 },
    async (at) => {
      positions.push(at);
    },
    (value) => states.push(value),
    {
      now: () => now,
      wait: async () => {
        now += 50;
        if (now === 50) control.setSpeed(2);
      },
    },
  );
  await control.play();
  assert.equal(states.at(-1)!.status, 'ended');
  assert.deepEqual(positions, [1000, 1000, 1050, 1150, 1250, 1300]);
  assert.equal(states.at(-1)!.at, 1300);
});
test('pause during a wait freezes time and resume continues from that position', async () => {
  let now = 0,
    latest!: PlayerState;
  const waiting = deferred();
  const control = new PlaybackPlayer(
    { start: 1000, end: 1200 },
    async () => {},
    (value) => {
      latest = value;
    },
    {
      now: () => now,
      wait: async (_ms, signal) => {
        waiting.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    },
  );
  const playing = control.play();
  await waiting.promise;
  now = 25;
  await control.pause();
  await playing;
  assert.equal(latest.at, 1025);
  assert.equal(latest.status, 'paused');
  now = 1000;
  const resumed = control.play();
  await Promise.resolve();
  await Promise.resolve();
  control.dispose();
  await resumed;
  assert.equal(latest.at, 1025, 'Time spent paused does not advance playback');
});
test('rapid seeks serialize rendering and cancelled writes cannot publish old positions', async () => {
  const entered = deferred(),
    release = deferred();
  const positions: number[] = [],
    states: PlayerState[] = [];
  const control = new PlaybackPlayer(
    { start: 0, end: 100 },
    async (at) => {
      positions.push(at);
      if (at === 10) {
        entered.resolve();
        await release.promise;
      }
    },
    (value) => states.push(value),
  );
  const old = control.seek(10);
  await entered.promise;
  const skipped = control.seek(20),
    newest = control.seek(30);
  release.resolve();
  await Promise.all([old, skipped, newest]);
  assert.deepEqual(positions, [10, 30]);
  assert.equal(states.at(-1)!.at, 30);
  assert.ok(!states.some((s) => s.at === 10 && s.status === 'paused'));
});
test('failed render retains safe error, retry reconstructs, and dispose prevents late state', async () => {
  const states: PlayerState[] = [];
  let fail = true;
  const control = new PlaybackPlayer(
    { start: 0, end: 100 },
    async () => {
      if (fail) throw new Error('Recording links expired.');
    },
    (value) => states.push(value),
  );
  await control.seek(50);
  assert.equal(states.at(-1)!.status, 'error');
  assert.equal(states.at(-1)!.error?.message, 'Recording links expired.');
  fail = false;
  await control.seek(50);
  assert.equal(states.at(-1)!.status, 'paused');
  control.dispose();
  const count = states.length;
  await control.seek(20);
  assert.equal(states.length, count);
  assert.throws(() => control.setSpeed(3), /speed/);
});
test('terminal range rejects overlaps, clamps player seeks, and handles empty or zero-duration recordings', async () => {
  assert.equal(terminalRange([]), null);
  const track = {
    url: 'https://bucket.s3.amazonaws.com/x',
    startedAt: '2026-10-18T00:00:00Z',
    endedAt: '2026-10-18T00:00:01Z',
  };
  assert.throws(() => terminalRange([track, track]), /order/);
  assert.throws(() => terminalRange([{ ...track, endedAt: 'invalid' }]), /order/);
  let latest!: PlayerState;
  const control = new PlaybackPlayer(
    { start: 100, end: 100 },
    async () => {},
    (s) => {
      latest = s;
    },
  );
  await control.seek(-100);
  assert.equal(latest.at, 100);
  await control.play();
  assert.equal(latest.status, 'ended');
});
test('backward reconstruction restores recorded dimensions and preserves output at equal timestamps', async () => {
  const start = Date.parse('2026-10-18T00:00:00Z');
  const track = {
    url: 'https://bucket.s3.amazonaws.com/x',
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 1000).toISOString(),
  };
  const body = [
    JSON.stringify({ version: 2, width: 80, height: 24, timestamp: start / 1000, duration: 1 }),
    JSON.stringify([0, 'o', 'old']),
    JSON.stringify([1, 'r', '120x30']),
    JSON.stringify([1, 'i', 'never execute']),
    JSON.stringify([1, 'o', 'new']),
  ].join('\n');
  let output = '',
    size: number[] = [];
  const source = new TerminalRecording(
    [track],
    {
      reset: () => {
        output = '';
      },
      resize: (...values) => {
        size = values;
      },
      write: async (text) => {
        output += text;
      },
    },
    async () => body,
  );
  await source.render(start + 1000, new AbortController().signal);
  assert.equal(output, 'oldnew');
  assert.deepEqual(size, [120, 30]);
  await source.render(start, new AbortController().signal);
  assert.equal(output, 'old');
  assert.deepEqual(size, [80, 24]);
});
test('slow reconstruction does not advance the playback clock when paused', async () => {
  const entered = deferred(),
    release = deferred();
  let now = 0,
    latest!: PlayerState,
    first = true;
  const control = new PlaybackPlayer(
    { start: 1000, end: 10000 },
    async () => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
    },
    (state) => {
      latest = state;
    },
    { now: () => now, wait: async () => {} },
  );
  const playing = control.play();
  await entered.promise;
  now = 5000;
  const paused = control.pause();
  release.resolve();
  await Promise.all([playing, paused]);
  assert.equal(latest.at, 1000);
  assert.equal(latest.status, 'paused');
  control.dispose();
});
