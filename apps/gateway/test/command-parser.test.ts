import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { isCommandParserCheckpoint } from '../../../packages/contracts/private/command-evidence.js';
import type { TerminalRecordingEvent } from '../../../packages/contracts/private/terminal-recording.js';
import { initialCommandParser, parseCommandEvents } from '../src/command-parser.js';

const at = '2026-10-12T00:00:00.000Z';
const mark = (text: string) => `\x1b]133;${text}\x07`;
const start = (text: string) => mark(`C;${Buffer.from(text).toString('base64')}`);
const output = (text: string | Buffer, sequence = 1): TerminalRecordingEvent => ({
  type: 'output',
  sequence,
  recordedAt: at,
  data: Buffer.from(text).toString('base64'),
});
const input = (text: string, sequence: number): TerminalRecordingEvent => ({
  type: 'input',
  sequence,
  recordedAt: at,
  data: Buffer.from(text).toString('base64'),
});

test('forms one event per top-level command and strips terminal controls', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(
      mark('A') + 'root# ' + mark('B') + start('false; true') + '\x1b[31mresult\x1b[0m\r\n' + mark('D;0') + mark('A'),
    ),
  ]);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]!.command, 'false; true');
  assert.equal(result.commands[0]!.outputExcerpt, 'result\n');
  assert.equal(result.commands[0]!.exitStatus, 0);
});

test('checkpoint replay handles every byte boundary, including UTF-8 and OSC ST', () => {
  const source = randomUUID();
  const bytes = Buffer.from(start('printf é') + 'é😀' + '\x1b]0;title\x1b\\' + mark('D;7'));
  const whole = parseCommandEvents(initialCommandParser(source), [output(bytes)]);
  for (let split = 1; split < bytes.length; split++) {
    const first = parseCommandEvents(initialCommandParser(source), [output(bytes.subarray(0, split))]);
    const next = parseCommandEvents(JSON.parse(JSON.stringify(first.checkpoint)), [output(bytes.subarray(split), 2)]);
    assert.deepEqual([...first.commands, ...next.commands], whole.commands, `split ${split}`);
  }
});

test('plain input fallback has no completion proof and markers replace it without double count', () => {
  let state = initialCommandParser(randomUUID());
  const first = parseCommandEvents(state, [output(mark('B')), input('cat /etc/nginx/nginx.conf\n', 2)]);
  state = first.checkpoint;
  assert.equal(state.count, 1);
  const result = parseCommandEvents(state, [
    output(start('cat /etc/nginx/nginx.conf') + 'proxy_pass 8081' + mark('D;0'), 3),
  ]);
  assert.equal(result.commands[0]!.seq, 1);
  assert.equal(result.commands[0]!.endedAt, at);
  const fallback = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(mark('B')),
    input('cat config\n', 2),
    output('text' + mark('A'), 3),
  ]);
  assert.equal(fallback.commands[0]!.endedAt, null);
  assert.equal(fallback.commands[0]!.exitStatus, null);
});

test('does not turn program input into a separate command', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('psql')),
    input('select 1;\n', 2),
    output('1\n' + mark('D;0'), 3),
  ]);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]!.command, 'psql');
  assert.equal(result.checkpoint.lossAt, null);
});

test('omits alternate-screen output, including output before entry and after exit', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('vim config') + 'before\x1b[?1049hsecret\x1b[?1049lafter' + mark('D;0')),
  ]);
  assert.equal(result.commands[0]!.outputExcerpt, '');
  assert.equal(result.commands[0]!.outputTruncated, true);
});

test('omits alternate-screen output when DEC modes share one control sequence', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('vim config') + 'before\x1b[?1;1049hsecret\x1b[?1;1049lafter' + mark('D;0')),
  ]);
  assert.equal(result.commands[0]!.outputExcerpt, '');
  assert.equal(result.commands[0]!.outputTruncated, true);
});

test('bounds oversized markers, excerpts, and commands without silently declaring completeness', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('cat config') + 'x'.repeat(7000)),
    output('y'.repeat(7000) + mark('D;0'), 2),
  ]);
  assert.equal(result.commands[0]!.outputExcerpt.length, 4000);
  assert.equal(result.commands[0]!.outputTruncated, true);
  let state = initialCommandParser(randomUUID());
  for (let n = 1; n <= 4; n++)
    state = parseCommandEvents(state, [output((n === 1 ? '\x1b]133;C;' : '') + 'x'.repeat(7000), n)]).checkpoint;
  assert.equal(state.mode, 'discard_osc');
  assert.equal(state.lossAt, at);
  const recovered = parseCommandEvents(state, [output('\x07' + start('true') + mark('D;0'), 5)]);
  assert.equal(recovered.commands.length, 1);
  assert.equal(recovered.commands[0]!.command, 'true');
});

test('shell truncation marker and retained-byte exhaustion mark evidence loss', () => {
  const source = randomUUID();
  const truncated = parseCommandEvents(initialCommandParser(source), [output(mark('T') + start(':') + mark('D;0'))]);
  assert.equal(truncated.checkpoint.lossAt, at);
  const full = parseCommandEvents({ ...initialCommandParser(source), retainedBytes: 20_000_000 }, [
    output(start(':') + mark('D;0')),
  ]);
  assert.equal(full.commands.length, 0);
  assert.equal(full.checkpoint.lossAt, at);
});
test('idle input uses a Unicode character bound, not a UTF-16 code-unit bound', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(mark('B')),
    input('😀'.repeat(3000), 2),
  ]);
  assert.equal(Array.from(result.checkpoint.inputLine).length, 3000);
  assert.equal(result.checkpoint.lossAt, null);
});

test('shell exit and missing completion remain incomplete command evidence', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('sleep 10') + 'partial'),
    { type: 'exit', sequence: 2, recordedAt: at, code: 1 },
  ]);
  assert.equal(result.commands[0]!.endedAt, null);
  assert.equal(result.commands[0]!.outputExcerpt, 'partial');
});

test('shell exit cannot hide an unfinished control sequence', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('true') + '\x1b]133;D;'),
    { type: 'exit', sequence: 2, recordedAt: at, code: 0 },
  ]);
  assert.equal(result.commands[0]!.endedAt, null);
  assert.equal(result.checkpoint.lossAt, at);
});

test('rejects discontinuity and invalid persisted state and marks malformed marker loss', () => {
  const initial = initialCommandParser(randomUUID());
  assert.throws(() => parseCommandEvents(initial, [output('text', 2)]));
  assert.equal(isCommandParserCheckpoint({ ...initial, count: -1 }), false);
  assert.equal(parseCommandEvents(initial, [output(mark('C;invalid!'))]).checkpoint.lossAt, at);
  assert.equal(parseCommandEvents(initial, [output(Buffer.from([0xff]))]).checkpoint.lossAt, at);
});

test('total command limit marks loss but source page size does not', () => {
  const initial = { ...initialCommandParser(randomUUID()), count: 5000 };
  const result = parseCommandEvents(initial, [output(start('true') + mark('D;0'))]);
  assert.equal(result.commands.length, 0);
  assert.equal(result.checkpoint.lossAt, at);
  const many = parseCommandEvents(initialCommandParser(randomUUID()), [output((start(':') + mark('D;0')).repeat(21))]);
  assert.equal(many.commands.length, 21);
  assert.equal(many.checkpoint.lossAt, null);
});

test('long editor input and no-echo secrets never enter command text or mark parser loss', () => {
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('vim config') + '\x1b[?1049h'),
    input('private-password\n' + 'x'.repeat(8000), 2),
    output('\x1b[?1049l' + mark('D;0'), 3),
  ]);
  assert.equal(result.commands[0]!.command, 'vim config');
  assert.equal(result.commands[0]!.outputExcerpt, '');
  assert.equal(result.checkpoint.lossAt, null);
  const secret = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(start('read -s password')),
    input('private-password\n', 2),
    output(mark('D;0'), 3),
  ]);
  assert.equal(secret.commands[0]!.command, 'read -s password');
  assert.equal(JSON.stringify(secret).includes('private-password'), false);
});

test('confirmed proposal command markers retain attribution without affecting exit evidence', () => {
  const id = randomUUID(),
    command = 'cat /var/log/nginx/error.log';
  const result = parseCommandEvents(initialCommandParser(randomUUID()), [
    output(mark('C;' + Buffer.from(command).toString('base64') + ';' + id) + 'failures' + mark('D;0')),
  ]);
  assert.equal(result.commands[0]?.source, 'assistant');
  assert.equal(result.commands[0]?.proposalId, id);
  assert.equal(result.commands[0]?.exitStatus, 0);
});
