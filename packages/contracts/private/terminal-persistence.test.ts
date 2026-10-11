import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceTerminalCheckpoint,
  encodeTerminalPage,
  initialTerminalCheckpoint,
  isStoredTerminalPage,
  isTerminalRecordingCheckpoint,
  terminalMetadataContinues,
} from './terminal-persistence.js';
import { terminalOutput, terminalPage, terminalReady } from './test-support/terminal-fixture.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
test('checkpoint validates exact metadata, byte count, and committed frontier', () => {
  const initial = initialTerminalCheckpoint(terminalReady());
  assert.ok(isTerminalRecordingCheckpoint(initial));
  const page = terminalPage();
  const next = advanceTerminalCheckpoint(initial, page);
  assert.equal(next.cursor, 1);
  assert.deepEqual(next.frontier, page.events[0]);
  assert.equal(next.recordedBytes, Buffer.byteLength(JSON.stringify(page.events[0])));
  for (const invalid of [
    { ...next, cursor: 2 },
    { ...next, recordedBytes: 0 },
    { ...next, unknown: true },
    { ...next, metadata: { ...next.metadata, type: 'recording_ready' } },
    { ...next, frontier: null },
    { ...next, frontier: { type: 'output', sequence: 1, recordedAt: next.metadata.startedAt, data: 'eA==' } },
  ]) {
    assert.equal(isTerminalRecordingCheckpoint(invalid), false);
  }
});
test('empty end read cannot acknowledge an uncommitted prefix or validate exit', () => {
  const current = initialTerminalCheckpoint(terminalReady());
  assert.throws(() => advanceTerminalCheckpoint(current, terminalPage([], { nextSequence: 1 })));
  assert.throws(() => advanceTerminalCheckpoint(current, terminalPage([], { nextSequence: 0, latestSequence: 1 })));
  const exited = initialTerminalCheckpoint(terminalReady({ shellState: 'exited', latestSequence: 2 }));
  assert.equal(exited.frontier, null);
  assert.throws(() =>
    advanceTerminalCheckpoint(exited, terminalPage([], { nextSequence: 2, latestSequence: 2, shellState: 'exited' })),
  );
});
test('valid pages advance without aliasing caller bytes', () => {
  const initial = initialTerminalCheckpoint(terminalReady());
  const previous = advanceTerminalCheckpoint(initial, terminalPage());
  const page = terminalPage([terminalOutput()]);
  const next = advanceTerminalCheckpoint(previous, page);
  assert.equal(next.cursor, 2);
  page.events[0]!.recordedAt = '2026-10-12T00:00:02.000Z';
  assert.equal(next.frontier!.recordedAt, '2026-10-12T00:00:01.000Z');
  const invalid = [
    terminalPage([terminalOutput(3)]),
    terminalPage([terminalOutput()], { source: sessionId }),
    terminalPage([terminalOutput()], { startedAt: '2026-10-11T00:00:00.000Z' }),
    terminalPage([terminalOutput(2, '2026-10-11T00:00:00.000Z')]),
    terminalPage([terminalOutput(2, '2026-10-12T00:00:00.000Z')], { observedAt: '2026-10-11T00:00:00.000Z' }),
  ];
  for (const item of invalid) assert.throws(() => advanceTerminalCheckpoint(previous, item));
  const observed = advanceTerminalCheckpoint(
    previous,
    terminalPage([], { nextSequence: 1, latestSequence: 1, observedAt: '2026-10-12T00:00:02.000Z' }),
  );
  assert.throws(() => advanceTerminalCheckpoint(observed, terminalPage([terminalOutput()])));
});
test('permanent loss permits reserved exit but never clears or resumes normal data', () => {
  const loss = { reason: 'limit_exceeded' as const, occurredAt: '2026-10-12T00:00:01.000Z' };
  const previous = advanceTerminalCheckpoint(
    initialTerminalCheckpoint(terminalReady()),
    terminalPage(undefined, { loss, observedAt: loss.occurredAt }),
  );
  assert.throws(() =>
    advanceTerminalCheckpoint(previous, terminalPage([terminalOutput(2, '2026-10-12T00:00:02.000Z')], { loss })),
  );
  const exit = { type: 'exit' as const, sequence: 2, recordedAt: '2026-10-12T00:00:02.000Z', code: 7 };
  const next = advanceTerminalCheckpoint(previous, terminalPage([exit], { loss, shellState: 'exited' }));
  assert.ok(isTerminalRecordingCheckpoint(next));
  assert.equal(next.frontier!.type, 'exit');
  assert.equal(terminalMetadataContinues(next.metadata, { ...next.metadata, loss: null }), false);
  assert.equal(terminalMetadataContinues(next.metadata, { ...next.metadata, shellState: 'running' }), false);
  assert.equal(
    terminalMetadataContinues(previous.metadata, { ...previous.metadata, latestSequence: 3, shellState: 'exited' }),
    false,
  );
});
test('resumes an already exited source across old backlog pages and an empty final observation', () => {
  const metadata = { latestSequence: 3, observedAt: '2026-10-12T00:00:02.000Z', shellState: 'exited' as const };
  let checkpoint = initialTerminalCheckpoint(terminalReady(metadata));
  checkpoint = advanceTerminalCheckpoint(checkpoint, terminalPage(undefined, metadata));
  checkpoint = advanceTerminalCheckpoint(checkpoint, terminalPage([terminalOutput()], metadata));
  checkpoint = advanceTerminalCheckpoint(
    checkpoint,
    terminalPage([{ type: 'exit', sequence: 3, recordedAt: metadata.observedAt, code: 0 }], metadata),
  );
  const last = advanceTerminalCheckpoint(
    checkpoint,
    terminalPage([], { ...metadata, nextSequence: 3, observedAt: '2026-10-12T00:00:03.000Z' }),
  );
  assert.equal(last.cursor, 3);
  assert.equal(last.frontier!.type, 'exit');
  assert.equal(last.recordedBytes, checkpoint.recordedBytes);
  assert.throws(() =>
    advanceTerminalCheckpoint(
      last,
      terminalPage([terminalOutput(4, '2026-10-12T00:00:03.000Z')], { ...metadata, latestSequence: 4 }),
    ),
  );
});
test('source exit requires a newly appended final event and loss property order is immaterial', () => {
  const previous = terminalReady();
  assert.equal(terminalMetadataContinues(previous, { ...previous, shellState: 'exited' }), false);
  const loss = { reason: 'data_gap' as const, occurredAt: previous.startedAt };
  const exited = { ...previous, shellState: 'exited' as const, latestSequence: 2, loss };
  assert.equal(
    terminalMetadataContinues(exited, { ...exited, loss: { occurredAt: loss.occurredAt, reason: loss.reason } }),
    true,
  );
});
test('encoding is canonical, bounded, byte-preserving, and reference-specific', () => {
  const bytes = Buffer.from([0, 0xff, 0xc3, 0xa9, 27]);
  const page = terminalPage([terminalOutput(2, '2026-10-12T00:00:01.000Z', bytes)]);
  const value = encodeTerminalPage(sessionId, 9, 1, page);
  assert.ok(isStoredTerminalPage(value.reference, sessionId, 9));
  assert.equal(isStoredTerminalPage(value.reference, sessionId, 10), false);
  assert.equal(isStoredTerminalPage({ ...value.reference, byteLength: 32 * 1024 + 1 }, sessionId, 9), false);
  assert.equal(isStoredTerminalPage({ ...value.reference, nextSequence: 5 }, sessionId, 9), false);
  assert.deepEqual(Buffer.from(JSON.parse(value.body.toString()).page.events[0].data, 'base64'), bytes);
  const reordered = {
    ...page,
    events: [
      { data: bytes.toString('base64'), type: 'output' as const, recordedAt: page.events[0]!.recordedAt, sequence: 2 },
    ],
  };
  assert.deepEqual(encodeTerminalPage(sessionId, 9, 1, reordered), value);
  assert.throws(() => encodeTerminalPage(sessionId, 1, 1, terminalPage([], { nextSequence: 1 })));
});
