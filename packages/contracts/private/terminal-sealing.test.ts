import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceTerminalCheckpoint, initialTerminalCheckpoint } from './terminal-persistence.js';
import {
  encodeSealedTerminalPage,
  isSealedTerminalPage,
  isTerminalSealState,
  terminalCoversCutoff,
} from './terminal-sealing.js';
import { terminalOutput, terminalPage, terminalReady } from './test-support/terminal-fixture.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const cutoffAt = '2026-10-12T00:00:01.000Z';
const page = terminalPage([terminalPage().events[0]!, terminalOutput(), terminalOutput(3, '2026-10-12T00:00:02.000Z')]);
const checkpoint = advanceTerminalCheckpoint(initialTerminalCheckpoint(terminalReady()), page);
const state = {
  schemaVersion: 1,
  cutoffAt,
  checkpoint,
  cursor: 2,
  pageCount: 1,
  recordedBytes: 200,
  lastAt: cutoffAt,
  excludedAt: '2026-10-12T00:00:02.000Z',
  complete: true,
};

test('sealed state requires source coverage and a bounded contiguous prefix or exclusion', () => {
  assert.ok(isTerminalSealState(state));
  assert.ok(terminalCoversCutoff(checkpoint, cutoffAt));
  for (const invalid of [
    { ...state, excludedAt: null },
    { ...state, excludedAt: cutoffAt },
    { ...state, excludedAt: '2026-10-12T00:00:03.000Z' },
    { ...state, cursor: checkpoint.cursor },
    { ...state, recordedBytes: checkpoint.recordedBytes + 1 },
    { ...state, cursor: 0 },
    { ...state, cursor: 4 },
    { ...state, pageCount: 0 },
    { ...state, lastAt: null },
    { ...state, extra: true },
    {
      ...state,
      checkpoint: {
        ...checkpoint,
        metadata: { ...checkpoint.metadata, loss: { reason: 'data_gap', occurredAt: cutoffAt } },
      },
    },
  ])
    assert.equal(isTerminalSealState(invalid), false);
});

test('sealed pages preserve byte data, canonical object identity, and strict sequence ranges', () => {
  const events = [terminalOutput(2, cutoffAt, Buffer.from([0, 0xff, 0xc3, 0xa9]))];
  const encoded = encodeSealedTerminalPage(sessionId, 9, page.source, 1, events);
  assert.ok(isSealedTerminalPage(encoded.reference, sessionId));
  assert.deepEqual(
    Buffer.from(JSON.parse(encoded.body.toString()).events[0].data, 'base64'),
    Buffer.from([0, 0xff, 0xc3, 0xa9]),
  );
  assert.equal(isSealedTerminalPage({ ...encoded.reference, after: 0 }, sessionId), false);
  assert.equal(
    isSealedTerminalPage(
      { ...encoded.reference, objectKey: encoded.reference.objectKey.replace('/sealed/', '/live/') },
      sessionId,
    ),
    false,
  );
  assert.throws(() => encodeSealedTerminalPage(sessionId, 1, page.source, 0, events));
  assert.throws(() => encodeSealedTerminalPage(sessionId, 1, page.source, 1, []));
});
