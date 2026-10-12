import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAsciicast, type CastState } from '../../../packages/session/src/asciicast.js';
import type { TerminalRecordingEvent } from '../../../packages/contracts/private/terminal-recording.js';
const at = '2026-10-12T00:00:00.000Z';
const state = (): CastState => ({
  columns: 80,
  rows: 24,
  utf8Tail: '',
  inputTail: '',
  markerPrefix: '',
  markerDiscard: false,
  markerEscaped: false,
});
const event = (sequence: number, bytes: Buffer, type: 'input' | 'output' = 'output'): TerminalRecordingEvent => ({
  sequence,
  recordedAt: at,
  type,
  data: bytes.toString('base64'),
});
const lines = (body: Buffer) =>
  body
    .toString()
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const text = (body: Buffer, kind = 'o') =>
  lines(body)
    .slice(1)
    .filter((line) => line[1] === kind)
    .map((line) => line[2])
    .join('');
test('v2 preserves output, recorded input, resize, exit and local clock without execution', () => {
  const cast = encodeAsciicast(
    state(),
    [
      event(1, Buffer.from('echo ok\n'), 'input'),
      { type: 'dimensions', sequence: 2, recordedAt: at, columns: 120, rows: 500 },
      event(3, Buffer.from('\x1b[31mok\x1b[0m\r\n')),
      { type: 'exit', sequence: 4, recordedAt: '2026-10-12T00:00:01.000Z', code: 0 },
    ],
    true,
  );
  const output = lines(cast.body);
  assert.equal(output[0].version, 2);
  assert.equal(output[0].duration, 1);
  assert.deepEqual(output[2], [0, 'r', '120x500']);
  assert.deepEqual(output.at(-1), [1, 'm', 'Shell exited']);
  assert.equal(text(cast.body, 'i'), 'echo ok\n');
  assert.equal(text(cast.body), '\x1b[31mok\x1b[0m\r\n');
});
test('every UTF-8 split survives output and input chunk boundaries', () => {
  const bytes = Buffer.from('α🙂中');
  for (const kind of ['input', 'output'] as const)
    for (let split = 1; split < bytes.length; split++) {
      const first = encodeAsciicast(state(), [event(1, bytes.subarray(0, split), kind)]);
      const second = encodeAsciicast(first.state, [event(2, bytes.subarray(split), kind)], true);
      assert.equal(
        text(first.body, kind === 'input' ? 'i' : 'o') + text(second.body, kind === 'input' ? 'i' : 'o'),
        'α🙂中',
      );
      assert.equal(second.state.utf8Tail, '');
      assert.equal(second.state.inputTail, '');
    }
});
test('only OSC 133 metadata is removed, including every split and both terminators', () => {
  for (const ending of ['\x07', '\x1b\\']) {
    const bytes = Buffer.from(`left\x1b]133;C;hidden metadata${ending}right\x1b]0;title\x07`);
    for (let split = 1; split < bytes.length; split++) {
      const first = encodeAsciicast(state(), [event(1, bytes.subarray(0, split))]);
      const second = encodeAsciicast(first.state, [event(2, bytes.subarray(split))], true);
      assert.equal(text(first.body) + text(second.body), 'leftright\x1b]0;title\x07');
    }
  }
});
test('cutoff flushes incomplete scalar conservatively and does not leak unfinished metadata', () => {
  const cast = encodeAsciicast(state(), [event(1, Buffer.from([0xf0, 0x9f]))], true);
  assert.equal(text(cast.body), '�');
  const marker = encodeAsciicast(state(), [event(1, Buffer.from('before\x1b]133;C;secret'))], true);
  assert.equal(text(marker.body), 'before');
  const pending = encodeAsciicast(state(), [event(1, Buffer.from([0xf0]))]);
  const flushed = encodeAsciicast(pending.state, [], true, at);
  assert.equal(text(flushed.body), '�');
});
test('maximum source-byte JSON expansion stays inside a chunk and aggregate ceiling', () => {
  const bytes = Buffer.alloc(16 * 1024);
  const cast = encodeAsciicast(state(), [event(1, bytes, 'input')], true);
  assert.equal(text(cast.body, 'i'), bytes.toString());
  assert.ok(cast.body.length > bytes.length * 6);
  assert.ok(cast.body.length <= 256 * 1024);
  // This bound includes a fresh header and event syntax for every source event.
  assert.ok(cast.body.length <= bytes.length * 6 + 512);
});
test('invalid sequence, clock and unbounded pages are rejected', () => {
  assert.throws(() => encodeAsciicast(state(), []));
  assert.throws(() => encodeAsciicast(state(), [event(1, Buffer.from('a')), event(3, Buffer.from('b'))]));
  assert.throws(() =>
    encodeAsciicast(
      state(),
      Array.from({ length: 101 }, (_, i) => event(i + 1, Buffer.from('a'))),
    ),
  );
  assert.throws(() => encodeAsciicast(state(), [{ ...event(1, Buffer.from('a')), recordedAt: 'bad' }]));
});
