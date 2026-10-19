import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { streamAssistant } from '../src/assistant/stream.js';
const request = { requestId: randomUUID(), text: 'Inspect the errors' };
const make = (events: unknown[], split = 7) => {
  const bytes = new TextEncoder().encode(events.map((event) => 'data: ' + JSON.stringify(event) + '\r\n\r\n').join(''));
  return new Response(
    new ReadableStream({
      start(c) {
        for (let at = 0; at < bytes.length; at += split) c.enqueue(bytes.slice(at, at + split));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};
const started = {
  type: 'turn_started',
  turnId: request.requestId,
  sequence: 0,
  data: { requestId: request.requestId },
};
const delta = { type: 'text_delta', turnId: request.requestId, sequence: 1, data: { text: 'Check the café logs.' } };
const completed = {
  type: 'turn_completed',
  turnId: request.requestId,
  sequence: 2,
  data: {
    id: request.requestId,
    status: 'completed',
    text: 'Check the café logs.',
    proposals: [],
    expiresAt: '2026-10-20T00:01:00Z',
  },
};
test('assistant stream handles split UTF-8 and CRLF frames without losing the saved answer', async () => {
  const observed: unknown[] = [];
  await streamAssistant(
    'https://api.example',
    'test',
    randomUUID(),
    request,
    (e) => observed.push(e),
    AbortSignal.timeout(1000),
    async () => make([started, delta, completed], 1),
  );
  assert.deepEqual(observed, [started, delta, completed]);
});
test('assistant stream rejects cross-turn events, skipped sequences and events after completion', async () => {
  for (const events of [
    [started, { ...delta, turnId: randomUUID() }],
    [started, { ...delta, sequence: 3 }],
    [started, delta, completed, { ...delta, sequence: 3 }],
    [delta],
  ])
    await assert.rejects(
      streamAssistant(
        'https://api.example',
        'test',
        randomUUID(),
        request,
        () => {},
        AbortSignal.timeout(1000),
        async () => make(events),
      ),
    );
});
test('EOF without completion remains provisional for saved GET recovery', async () => {
  const observed: unknown[] = [];
  await streamAssistant(
    'https://api.example',
    'test',
    randomUUID(),
    request,
    (e) => observed.push(e),
    AbortSignal.timeout(1000),
    async () => make([started, delta]),
  );
  assert.equal(observed.length, 2);
});
