import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ApiClient } from '../src/api.js';
import { parseCast, metricSamples, captureObject, readAsset, assetUrl, AssetExpired } from '../src/playback/assets.js';
import { playbackPage, appendPlayback, savedDebrief } from '../src/playback/reads.js';
import { replayTerminal } from '../src/playback/terminal.js';
import { encodeAsciicast } from '../../../packages/session/src/asciicast.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const recording = JSON.parse(
  readFileSync(new URL('../../../packages/contracts/examples/playback.json', import.meta.url), 'utf8'),
);
const debrief = JSON.parse(
  readFileSync(new URL('../../../packages/contracts/examples/debrief.json', import.meta.url), 'utf8'),
);
const at = '2026-10-16T00:00:00.000Z';
test('real exporter chunks share terminal state and keep recorded input out of execution', async () => {
  const first = encodeAsciicast(
    {
      columns: 80,
      rows: 24,
      utf8Tail: '',
      inputTail: '',
      markerPrefix: '',
      markerDiscard: false,
      markerEscaped: false,
    },
    [{ sequence: 1, recordedAt: at, type: 'output', data: Buffer.from('first').toString('base64') }],
  );
  const later = '2026-10-16T00:00:02.000Z';
  const second = encodeAsciicast(first.state, [
    { sequence: 2, recordedAt: later, type: 'input', data: Buffer.from('rm dangerous\r').toString('base64') },
    { sequence: 3, recordedAt: later, type: 'output', data: Buffer.from('second').toString('base64') },
  ]);
  const tracks = [first, second].map((value, index) => ({
    url: `https://bucket.s3.amazonaws.com/${index}`,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
  }));
  const writes: string[] = [],
    sizes: number[][] = [],
    delays: number[] = [];
  await replayTerminal(
    tracks,
    new AbortController().signal,
    {
      write: async (text) => {
        writes.push(text);
      },
      resize: (cols, rows) => sizes.push([cols, rows]),
      time: () => {},
    },
    0,
    async (url) => [first, second][Number(url.slice(-1))]!.body.toString('utf8'),
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.deepEqual(writes, ['first', 'second']);
  assert.deepEqual(sizes, [[80, 24]]);
  assert.ok(delays.includes(500));
  assert.throws(() => parseCast(first.body.toString(), { ...tracks[0]!, startedAt: later }));
});
test('playback returns empty pages for explicit continuation and rejects cyclic cursors or a foreign session', async () => {
  let calls = 0;
  const urls: string[] = [];
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          ...recording,
          terminal: [],
          metrics: [],
          captures: [],
          nextCursor: ++calls === 1 ? 'next' : null,
        }),
      );
    },
  );
  const first = await playbackPage(api, id, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(first.nextCursor, 'next');
  const next = await playbackPage(api, id, new AbortController().signal, first.nextCursor);
  assert.equal(calls, 2);
  assert.match(urls[1]!, /cursor=next/);
  assert.equal(appendPlayback(first, next).nextCursor, null);
  const cycle = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () => new Response(JSON.stringify({ ...recording, nextCursor: 'same' })),
  );
  await assert.rejects(playbackPage(cycle, id, new AbortController().signal, 'same'), /advance/);
  await assert.rejects(
    playbackPage(api, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', new AbortController().signal),
    /match/,
  );
});
test('a recording can exceed one-page array limits while each read remains bounded and explicit', async () => {
  const track = { url: 'https://bucket.s3.amazonaws.com/x', startedAt: at, endedAt: at };
  const first = {
    ...recording,
    terminal: Array.from({ length: 500 }, () => track),
    metrics: [],
    captures: [],
    nextCursor: 'next',
  };
  const next = { ...recording, terminal: [track], metrics: [], captures: [], nextCursor: null };
  assert.equal(appendPlayback(first, next).terminal.length, 501);
  assert.throws(
    () => appendPlayback(first, { ...next, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    /snapshot/,
  );
});
test('debrief pending honors the server delay and incomplete results retain a null score', async () => {
  let calls = 0,
    delay = 0;
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () =>
      new Response(
        JSON.stringify(
          ++calls === 1
            ? { code: 'DEBRIEF_PENDING', message: 'Preparing', requestId: id, retryAfterSeconds: 3 }
            : { ...debrief, recording: { status: 'incomplete', reason: 'data_gap' }, score: null },
        ),
        { status: calls === 1 ? 409 : 200 },
      ),
  );
  const result = await savedDebrief(api, id, new AbortController().signal, async (ms) => {
    delay = ms;
  });
  assert.equal(delay, 3000);
  assert.equal(result.score, null);
  assert.equal(result.recording.status, 'incomplete');
});
test('recording fetches omit credentials, enforce bounds, and report expiry without leaking signed URLs', async () => {
  let request: RequestInit | undefined;
  await readAsset('https://bucket.s3.amazonaws.com/x', new AbortController().signal, 10, async (_url, options) => {
    request = options;
    return new Response('ok');
  });
  assert.equal(request?.credentials, 'omit');
  assert.equal(request?.headers, undefined);
  assert.equal(request?.redirect, 'error');
  await assert.rejects(
    readAsset(
      'https://bucket.s3.amazonaws.com/x',
      new AbortController().signal,
      1,
      async () => new Response('too big'),
    ),
    /size limit/,
  );
  await assert.rejects(
    readAsset(
      'https://bucket.s3.amazonaws.com/x',
      new AbortController().signal,
      10,
      async () => new Response('', { status: 403 }),
    ),
    AssetExpired,
  );
  assert.throws(() => assetUrl('https://evil.example/x'));
  assert.throws(() => assetUrl('https://user@bucket.s3.amazonaws.com/x'));
});
test('public recording objects reject private fields and mismatched capture intervals', async () => {
  const track = { url: 'https://bucket.s3.amazonaws.com/x', startedAt: at, endedAt: at };
  const metric = {
    type: 'metrics',
    sample: { at, values: { error_rate: 27 } },
    counters: { totalRequests: 10, failedRequests: 3 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
  assert.deepEqual(
    await metricSamples(
      JSON.stringify({ schemaVersion: 1, kind: 'playback_metrics', frames: [], final: metric }),
      track,
    ),
    [metric.sample],
  );
  await assert.rejects(
    metricSamples(
      JSON.stringify({ schemaVersion: 1, kind: 'playback_metrics', frames: [], final: metric, secret: 'hidden' }),
      track,
    ),
  );
  const capture = {
    schemaVersion: 1,
    commandId: id,
    commandSeq: 1,
    sequence: 1,
    baselineAt: at,
    startedAt: at,
    completedAt: at,
    files: [],
    logs: [],
    metrics: metric.sample,
    incomplete: false,
    unavailable: false,
  };
  const reference = { commandSeq: 1, url: track.url, baselineAt: at, startedAt: at, completedAt: at };
  assert.equal((await captureObject(JSON.stringify(capture), reference)).commandSeq, 1);
  await assert.rejects(captureObject(JSON.stringify(capture), { ...reference, commandSeq: 2 }), /match/);
});

test('stopping during a playback write prevents a late timeline update', async () => {
  const track = { url: 'https://bucket.s3.amazonaws.com/x', startedAt: at, endedAt: at };
  const body =
    JSON.stringify({ version: 2, width: 80, height: 24, timestamp: Date.parse(at) / 1000, duration: 0 }) +
    '\n' +
    JSON.stringify([0, 'o', 'output']) +
    '\n';
  const controller = new AbortController();
  let updates = 0;
  await assert.rejects(
    replayTerminal(
      [track],
      controller.signal,
      {
        resize: () => {},
        write: async () => {
          controller.abort();
        },
        time: () => {
          updates++;
        },
      },
      0,
      async () => body,
    ),
  );
  assert.equal(updates, 0);
});
