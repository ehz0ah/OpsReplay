import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTerminalRecordingAttach,
  isTerminalRecordingRead,
  isTerminalRecordingEvent,
  isTerminalRecordingReady,
  isTerminalRecordingPage,
  terminalRecordingSchema,
} from './terminal-recording.js';

const source = 'f5c45f32-16d4-4a1b-8e72-1fd935cdcc28';
const at = '2026-10-11T12:00:00.000Z';
const metadata = {
  version: 1,
  source,
  startedAt: at,
  initialColumns: 80,
  initialRows: 24,
  latestSequence: 1,
  observedAt: at,
  shellState: 'running',
  loss: null,
};
const dimensions = { sequence: 1, recordedAt: at, type: 'dimensions', columns: 80, rows: 24 };
const page = { ...metadata, type: 'recording_page', events: [dimensions], nextSequence: 1 };

test('recording requests have an exact independent schema and safe cursors', () => {
  assert.ok(isTerminalRecordingAttach({ type: 'attach', version: 1, mode: 'recording' }));
  assert.ok(!isTerminalRecordingAttach({ type: 'attach', version: 1, mode: 'recording', generation: 1 }));
  for (const after of [0, 1, 100_000]) assert.ok(isTerminalRecordingRead({ type: 'read', source, after }));
  for (const after of [-1, true, 1.5, 100_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.ok(!isTerminalRecordingRead({ type: 'read', source, after }));
  }
  assert.ok(!isTerminalRecordingRead({ type: 'read', source: 'another', after: 0 }));
});

test('events preserve canonical bytes and bound dimensions, bytes, and exit codes', () => {
  assert.ok(isTerminalRecordingEvent(dimensions));
  for (const type of ['input', 'output']) {
    assert.ok(isTerminalRecordingEvent({ sequence: 2, recordedAt: at, type, data: 'AP8=' }));
    for (const data of [
      '',
      'YQ',
      'YR==',
      ' YQ==',
      Buffer.alloc(terminalRecordingSchema.maximumInputBytes + 1).toString('base64'),
    ]) {
      assert.ok(!isTerminalRecordingEvent({ sequence: 2, recordedAt: at, type, data }));
    }
  }
  assert.ok(!isTerminalRecordingEvent({ ...dimensions, rows: 501 }));
  assert.ok(!isTerminalRecordingEvent({ ...dimensions, sequence: true }));
  assert.ok(!isTerminalRecordingEvent({ ...dimensions, recordedAt: '2026-02-30T00:00:00.000Z' }));
  assert.ok(!isTerminalRecordingEvent({ ...dimensions, extra: 1 }));
  assert.ok(isTerminalRecordingEvent({ sequence: 2, recordedAt: at, type: 'exit', code: -9 }));
});

test('metadata does not conceal source loss or accept noncanonical clocks', () => {
  assert.ok(isTerminalRecordingReady({ ...metadata, type: 'recording_ready' }));
  for (const reason of ['limit_exceeded', 'data_gap']) {
    assert.ok(isTerminalRecordingReady({ ...metadata, type: 'recording_ready', loss: { reason, occurredAt: at } }));
  }
  for (const change of [
    { source: 'another' },
    { initialRows: 25 },
    { latestSequence: 0 },
    { observedAt: '2026-10-11T11:59:59.000Z' },
    { loss: { reason: 'silent_eviction', occurredAt: at } },
    { loss: { reason: 'data_gap', occurredAt: '2026-10-11T12:00:01.000Z' } },
    { hidden: true },
  ])
    assert.ok(!isTerminalRecordingReady({ ...metadata, type: 'recording_ready', ...change }));
});

test('pages require matching source, contiguous prefix, ordered time, and truthful end', () => {
  assert.ok(isTerminalRecordingPage(page, source, 0));
  assert.ok(isTerminalRecordingPage({ ...page, events: [] }, source, 1));
  assert.ok(!isTerminalRecordingPage({ ...page }, 'another', 0));
  for (const change of [
    { nextSequence: 2 },
    { events: [] },
    { latestSequence: 0 },
    { events: [{ ...dimensions, sequence: 2 }], nextSequence: 2, latestSequence: 2 },
    { events: [{ ...dimensions, columns: 81 }] },
    { events: [{ ...dimensions, recordedAt: '2026-10-11T12:00:01.000Z' }] },
    { shellState: 'exited' },
  ])
    assert.ok(!isTerminalRecordingPage({ ...page, ...change }, source, 0));
  const maximalInput = { sequence: 2, recordedAt: at, type: 'input', data: Buffer.alloc(16 * 1024).toString('base64') };
  assert.ok(
    isTerminalRecordingPage(
      { ...page, events: [dimensions, maximalInput], nextSequence: 2, latestSequence: 2 },
      source,
      0,
    ),
  );
  assert.ok(
    !isTerminalRecordingPage(
      {
        ...page,
        events: [dimensions, maximalInput, { ...maximalInput, sequence: 3 }],
        nextSequence: 3,
        latestSequence: 3,
      },
      source,
      0,
    ),
  );
  const exit = { sequence: 2, recordedAt: at, type: 'exit', code: 7 };
  const ended = { ...page, shellState: 'exited', latestSequence: 2, events: [dimensions, exit], nextSequence: 2 };
  assert.ok(isTerminalRecordingPage(ended, source, 0));
  assert.ok(!isTerminalRecordingPage({ ...ended, shellState: 'running' }, source, 0));
  assert.ok(
    !isTerminalRecordingPage(
      { ...ended, events: [dimensions, exit, { ...dimensions, sequence: 3 }], nextSequence: 3, latestSequence: 3 },
      source,
      0,
    ),
  );
  assert.ok(
    !isTerminalRecordingPage(
      { ...page, shellState: 'exited', loss: { reason: 'data_gap', occurredAt: at } },
      source,
      0,
    ),
  );
});

test('permanent loss preserves only a final exit after the frozen data prefix', () => {
  const lostAt = '2026-10-11T12:00:01.000Z';
  const exitedAt = '2026-10-11T12:00:02.000Z';
  const output = { sequence: 2, recordedAt: lostAt, type: 'output', data: 'YQ==' };
  const exit = { sequence: 3, recordedAt: exitedAt, type: 'exit', code: 7 };
  for (const reason of ['limit_exceeded', 'data_gap']) {
    const ended = {
      ...page,
      observedAt: exitedAt,
      shellState: 'exited',
      loss: { reason, occurredAt: lostAt },
      latestSequence: 3,
      events: [dimensions, output, exit],
      nextSequence: 3,
    };
    assert.ok(isTerminalRecordingPage(ended, source, 0));
    assert.ok(isTerminalRecordingPage({ ...ended, events: [exit] }, source, 2));
    assert.ok(isTerminalRecordingPage({ ...ended, events: [], nextSequence: 3 }, source, 3));
    assert.ok(isTerminalRecordingPage({ ...ended, events: [dimensions], nextSequence: 1 }, source, 0));
    assert.ok(isTerminalRecordingPage({ ...ended, events: [dimensions, output], nextSequence: 2 }, source, 0));
    assert.ok(
      isTerminalRecordingPage(
        { ...ended, events: [dimensions, { ...output, recordedAt: at }, { ...exit, recordedAt: lostAt }] },
        source,
        0,
      ),
    );
    for (const change of [
      { shellState: 'running' },
      { shellState: 'exiting' },
      { events: [dimensions, output], nextSequence: 2, latestSequence: 2 },
      { events: [dimensions, output, { ...exit, recordedAt: at }] },
      { events: [dimensions, { ...output, recordedAt: at }, { ...exit, recordedAt: at }] },
      { events: [dimensions, output, { ...exit, recordedAt: '2026-10-11T12:00:03.000Z' }] },
      { events: [dimensions, output, { ...exit, sequence: 4 }], nextSequence: 4, latestSequence: 4 },
      { events: [dimensions, output, exit, { ...exit, sequence: 4 }], nextSequence: 4, latestSequence: 4 },
    ])
      assert.ok(!isTerminalRecordingPage({ ...ended, ...change }, source, 0));
    for (const data of [
      { ...output, recordedAt: exitedAt },
      { sequence: 2, recordedAt: exitedAt, type: 'input', data: 'YQ==' },
      { ...dimensions, sequence: 2, recordedAt: exitedAt },
    ])
      assert.ok(!isTerminalRecordingPage({ ...ended, events: [dimensions, data, exit] }, source, 0));
  }
});
