import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceTerminalCheckpoint,
  initialTerminalCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  terminalOutput,
  terminalPage,
  terminalReady,
} from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { TerminalRecorder, TerminalRecorderError, terminalCoversCutoff } from '../src/terminal-recorder.js';
import type { TerminalRecordingPage } from '../../../packages/contracts/private/terminal-recording.js';

const at = (second: number) => `2026-10-12T00:00:0${second}.000Z`;
function fixture(pages: TerminalRecordingPage[]) {
  const cursors: number[] = [];
  let closed = false;
  let saved = initialTerminalCheckpoint(terminalReady());
  const recorder = new TerminalRecorder({
    connect: async () => ({
      ready: terminalReady(),
      client: {
        read: async (cursor) => {
          cursors.push(cursor);
          const page = pages.shift();
          assert.ok(page);
          return page;
        },
        close: () => {
          closed = true;
        },
      },
    }),
    sink: {
      begin: async () => saved,
      append: async (previous, page) => {
        saved = advanceTerminalCheckpoint(previous, page);
        return saved;
      },
    },
    wait: async () => {},
  });
  return { recorder, cursors, closed: () => closed, saved: () => saved };
}

test('observations equal to cutoff do not exclude later equal-time events', async () => {
  const f = fixture([
    terminalPage(),
    terminalPage([], { observedAt: at(1) }),
    terminalPage([terminalOutput(2, at(1))]),
    terminalPage([], { nextSequence: 2, latestSequence: 2, observedAt: at(2) }),
  ]);
  const signal = new AbortController().signal;
  await f.recorder.begin(signal);
  const checkpoint = await f.recorder.record(signal, () => at(1));
  assert.equal(checkpoint.cursor, 2);
  assert.deepEqual(f.cursors, [0, 1, 1, 2]);
  assert.ok(terminalCoversCutoff(checkpoint, at(1)));
  f.recorder.close();
  assert.ok(f.closed());
});

test('an event strictly after cutoff covers a backlog while unresolved earlier pages do not', () => {
  const initial = initialTerminalCheckpoint(terminalReady({ latestSequence: 4, observedAt: at(4) }));
  const earlier = advanceTerminalCheckpoint(initial, terminalPage(undefined, { latestSequence: 4, observedAt: at(4) }));
  assert.equal(terminalCoversCutoff(earlier, at(1)), false);
  const later = advanceTerminalCheckpoint(
    earlier,
    terminalPage([terminalOutput(2, at(2))], { latestSequence: 4, observedAt: at(4) }),
  );
  assert.equal(terminalCoversCutoff(later, at(1)), true);
});

test('final exit provides coverage without waiting for a post-exit timestamp', async () => {
  const f = fixture([
    terminalPage(),
    terminalPage([{ type: 'exit', sequence: 2, recordedAt: at(1), code: 0 }], { shellState: 'exited' }),
  ]);
  const signal = new AbortController().signal;
  await f.recorder.begin(signal);
  assert.equal((await f.recorder.record(signal, () => at(1))).frontier?.type, 'exit');
});

test('a fully consumed exit closes the source and waits for lifecycle without more reads', async () => {
  const exit = terminalPage([{ type: 'exit', sequence: 2, recordedAt: at(1), code: 0 }], { shellState: 'exited' });
  let reads = 0;
  let closes = 0;
  let cutoff: string | null = null;
  const signal = new AbortController().signal;
  const recorder = new TerminalRecorder({
    connect: async () => ({
      ready: terminalReady(),
      client: {
        read: async () => {
          reads++;
          return exit;
        },
        close: () => {
          closes++;
        },
      },
    }),
    sink: {
      begin: async () => advanceTerminalCheckpoint(initialTerminalCheckpoint(terminalReady()), terminalPage()),
      append: async (previous, page) => advanceTerminalCheckpoint(previous, page),
    },
    wait: async () => {
      if (closes > 0) cutoff = at(3);
    },
  });
  await recorder.begin(signal);
  const final = await recorder.record(signal, () => cutoff);
  assert.equal(reads, 1);
  assert.equal(closes, 1);
  assert.equal(final.frontier?.type, 'exit');
});

test('loss before or at cutoff cannot become complete; loss after cutoff permits prefix sealing', async () => {
  for (const lossAt of [at(0), at(1)]) {
    const f = fixture([
      terminalPage(undefined, { loss: { reason: 'limit_exceeded', occurredAt: lossAt }, observedAt: at(1) }),
    ]);
    const signal = new AbortController().signal;
    await f.recorder.begin(signal);
    await assert.rejects(
      f.recorder.record(signal, () => at(1)),
      (error) => error instanceof TerminalRecorderError && error.code === 'limit_exceeded',
    );
  }
  const f = fixture([terminalPage(undefined, { loss: { reason: 'data_gap', occurredAt: at(2) }, observedAt: at(2) })]);
  const signal = new AbortController().signal;
  await f.recorder.begin(signal);
  assert.equal((await f.recorder.record(signal, () => at(1))).cursor, 1);
});

test('failed append leaves cursor unchanged and begin failure closes the private connection', async () => {
  let closed = false;
  const failure = new Error('Save failed');
  const recorder = new TerminalRecorder({
    connect: async () => ({
      ready: terminalReady(),
      client: {
        read: async () => terminalPage(),
        close: () => {
          closed = true;
        },
      },
    }),
    sink: {
      begin: async () => initialTerminalCheckpoint(terminalReady()),
      append: async () => {
        throw failure;
      },
    },
  });
  const signal = new AbortController().signal;
  await recorder.begin(signal);
  await assert.rejects(
    recorder.record(signal, () => at(1)),
    (error) => error === failure,
  );
  assert.equal(recorder.checkpoint.cursor, 0);
  recorder.close();
  assert.ok(closed);
  closed = false;
  const failedBegin = new TerminalRecorder({
    connect: async () => ({
      ready: terminalReady(),
      client: {
        read: async () => terminalPage(),
        close: () => {
          closed = true;
        },
      },
    }),
    sink: {
      begin: async () => {
        throw failure;
      },
      append: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(failedBegin.begin(signal), (error) => error === failure);
  assert.ok(closed);
});
