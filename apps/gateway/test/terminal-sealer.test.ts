import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceTerminalCheckpoint,
  encodeTerminalPage,
  initialTerminalCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  encodeSealedTerminalPage,
  type TerminalSealState,
} from '../../../packages/contracts/private/terminal-sealing.js';
import {
  terminalOutput,
  terminalPage,
  terminalReady,
} from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { TerminalSealer } from '../src/terminal-sealer.js';
import type { TerminalSealingStore } from '../src/terminal-sealing-store.js';
import type { TerminalPageArchive } from '../src/terminal-page-archive.js';
import { TerminalRecordingStoreError } from '../src/terminal-recording-store.js';

const lease = { sessionId: '11111111-1111-4111-8111-111111111111', recorderId: 'gateway-1', generation: 1 };
const cutoffAt = '2026-10-12T00:00:01.000Z';
const page = terminalPage([terminalPage().events[0]!, terminalOutput(), terminalOutput(3, '2026-10-12T00:00:02.000Z')]);
const checkpoint = advanceTerminalCheckpoint(initialTerminalCheckpoint(terminalReady()), page);
function fixture() {
  let state: TerminalSealState = {
    schemaVersion: 1,
    cutoffAt,
    checkpoint,
    cursor: 0,
    pageCount: 0,
    recordedBytes: 0,
    lastAt: null,
    excludedAt: null,
    complete: false,
  };
  const saved: unknown[] = [];
  const seals: TerminalSealingStore = {
    get: async () => state,
    begin: async () => structuredClone(state),
    nextPage: async () => encodeTerminalPage(lease.sessionId, 1, 0, page).reference,
    append: async (_lease, previous, reference, bytes) => {
      state = {
        ...previous,
        cursor: reference.nextSequence,
        pageCount: previous.pageCount + 1,
        recordedBytes: previous.recordedBytes + bytes,
        lastAt: reference.lastAt,
      };
      return state;
    },
    finish: async (_lease, previous, proof) => {
      const excludedAt = proof?.page.events.find((event) => event.sequence === previous.cursor + 1)?.recordedAt ?? null;
      state = { ...previous, excludedAt, complete: true };
      return state;
    },
  };
  const pages: TerminalPageArchive = {
    readLive: async () => structuredClone(page),
    putSealed: async (id, generation, source, after, events) => {
      saved.push(structuredClone(events));
      return encodeSealedTerminalPage(id, generation, source, after, events).reference;
    },
  };
  const sealer = new TerminalSealer({ lease, pages, seals, now: () => '2026-10-12T00:00:03.000Z' });
  return { sealer, pages, seals, saved, state: () => state };
}

test('keeps cutoff-equal events and excludes only later events from committed storage', async () => {
  const f = fixture();
  const result = await f.sealer.seal(checkpoint, cutoffAt);
  assert.equal(result.cursor, 2);
  assert.equal(result.pageCount, 1);
  assert.equal(result.excludedAt, '2026-10-12T00:00:02.000Z');
  assert.equal(result.complete, true);
  assert.deepEqual(f.saved, [page.events.slice(0, 2)]);
});

test('resumes a partially copied final page after a lost finish without rewriting copied events', async () => {
  const f = fixture();
  const finish = f.seals.finish;
  f.seals.finish = async () => {
    throw new Error('Finish failed');
  };
  await assert.rejects(f.sealer.seal(checkpoint, cutoffAt), { message: 'Finish failed' });
  assert.equal(f.state().cursor, 2);
  assert.equal(f.state().complete, false);
  f.seals.finish = finish;
  const result = await f.sealer.seal(checkpoint, cutoffAt);
  assert.equal(result.complete, true);
  assert.equal(f.saved.length, 1);
});

test('cancellation after a sealed upload does not advance the durable cursor or complete the seal', async () => {
  const f = fixture();
  const controller = new AbortController();
  const upload = f.pages.putSealed;
  f.pages.putSealed = async (...args) => {
    const reference = await upload(...args);
    controller.abort();
    return reference;
  };
  await assert.rejects(f.sealer.seal(checkpoint, cutoffAt, controller.signal), { name: 'AbortError' });
  assert.equal(f.saved.length, 1);
  assert.equal(f.state().cursor, 0);
  assert.equal(f.state().complete, false);
});

test('missing committed references and failed uploads cannot mark the terminal seal complete', async () => {
  const f = fixture();
  f.seals.nextPage = async () => undefined;
  await assert.rejects(
    f.sealer.seal(checkpoint, cutoffAt),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_store',
  );
  assert.equal(f.state().complete, false);
  const failed = fixture();
  failed.pages.putSealed = async () => {
    throw new Error('Upload failed');
  };
  await assert.rejects(failed.sealer.seal(checkpoint, cutoffAt), { message: 'Upload failed' });
  assert.equal(failed.state().cursor, 0);
  assert.equal(failed.state().complete, false);
});
