import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceTerminalCheckpoint,
  encodeTerminalPage,
  initialTerminalCheckpoint,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import { terminalPage, terminalReady } from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import type { TerminalChunkStore } from '../src/terminal-chunk-store.js';
import { DurableTerminalRecordingSink } from '../src/terminal-recording-sink.js';
import { TerminalRecordingStoreError, type TerminalRecordingStateStore } from '../src/terminal-recording-store.js';

const lease = { sessionId: '11111111-1111-4111-8111-111111111111', recorderId: 'gateway-1', generation: 1 };
const now = '2026-10-12T00:00:01.000Z';
function fixture() {
  const calls: string[] = [];
  let saved: TerminalRecordingCheckpoint | undefined;
  const chunks: TerminalChunkStore = {
    putPage: async (id, generation, after, page) => {
      calls.push('upload');
      return encodeTerminalPage(id, generation, after, page).reference;
    },
  };
  const recordings: TerminalRecordingStateStore = {
    get: async () => saved,
    begin: async (actualLease, ready, at) => {
      assert.deepEqual(actualLease, lease);
      assert.equal(at, now);
      calls.push('begin');
      saved = initialTerminalCheckpoint(ready);
      return saved;
    },
    commit: async (actualLease, previous, page, reference, at) => {
      assert.deepEqual(actualLease, lease);
      assert.equal(at, now);
      assert.deepEqual(
        reference,
        page.events.length === 0
          ? null
          : encodeTerminalPage(lease.sessionId, lease.generation, previous.cursor, page).reference,
      );
      calls.push('commit');
      saved = advanceTerminalCheckpoint(previous, page);
      return saved;
    },
  };
  const sink = new DurableTerminalRecordingSink({ lease, chunks, recordings, now: () => now });
  return { calls, chunks, recordings, sink, saved: () => saved };
}

test('begins through the existing lease and uploads before acknowledging a checkpoint', async () => {
  const f = fixture();
  const previous = await f.sink.begin(terminalReady());
  const next = await f.sink.append(previous, terminalPage());
  assert.deepEqual(f.calls, ['begin', 'upload', 'commit']);
  assert.equal(previous.cursor, 0);
  assert.equal(next.cursor, 1);
  assert.deepEqual(next, f.saved());
  await f.sink.append(next, terminalPage([], { observedAt: now }));
  assert.deepEqual(f.calls, ['begin', 'upload', 'commit', 'commit']);
});

test('a failed upload or commit does not acknowledge or advance the caller checkpoint', async () => {
  for (const stage of ['upload', 'commit'] as const) {
    const f = fixture();
    const previous = await f.sink.begin(terminalReady());
    const failure = new Error('Storage failed');
    if (stage === 'upload')
      f.chunks.putPage = async () => {
        f.calls.push('upload');
        throw failure;
      };
    else
      f.recordings.commit = async () => {
        f.calls.push('commit');
        throw failure;
      };
    await assert.rejects(f.sink.append(previous, terminalPage()), (actual) => actual === failure);
    assert.equal(previous.cursor, 0);
    assert.equal(f.saved()?.cursor, 0);
    assert.deepEqual(f.calls, stage === 'upload' ? ['begin', 'upload'] : ['begin', 'upload', 'commit']);
  }
});

test('validates before uploading and propagates cancellation between upload and commit', async () => {
  const f = fixture();
  const previous = await f.sink.begin(terminalReady());
  await assert.rejects(
    f.sink.append(previous, terminalPage([], { nextSequence: 1 })),
    (error) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_stream',
  );
  assert.deepEqual(f.calls, ['begin']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.sink.append(previous, terminalPage(), controller.signal), { name: 'AbortError' });
  assert.deepEqual(f.calls, ['begin']);
  const duringUpload = new AbortController();
  f.chunks.putPage = async (id, generation, after, page) => {
    f.calls.push('upload');
    duringUpload.abort();
    return encodeTerminalPage(id, generation, after, page).reference;
  };
  await assert.rejects(f.sink.append(previous, terminalPage(), duringUpload.signal), { name: 'AbortError' });
  assert.deepEqual(f.calls, ['begin', 'upload']);
});

test('snapshots caller metadata, events, and input lease while upload is pending', async () => {
  const f = fixture();
  const inputLease = { ...lease };
  const sink = new DurableTerminalRecordingSink({
    lease: inputLease,
    chunks: f.chunks,
    recordings: f.recordings,
    now: () => now,
  });
  const previous = await sink.begin(terminalReady());
  const page = terminalPage();
  f.chunks.putPage = async (id, generation, after, snapshot) => {
    previous.metadata.source = '33333333-3333-4333-8333-333333333333';
    page.events[0]!.sequence = 99;
    inputLease.generation = 99;
    return encodeTerminalPage(id, generation, after, snapshot).reference;
  };
  const next = await sink.append(previous, page);
  assert.equal(next.cursor, 1);
  assert.equal(next.metadata.source, terminalReady().source);
});
