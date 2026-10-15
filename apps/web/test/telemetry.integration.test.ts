import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { ApiClient, TransportError } from '../src/api.js';
import { mergeTimeline, mergeSamples, freshSample } from '../src/telemetry/state.js';
import { observeTimeline } from '../src/telemetry/timeline.js';
import { MutationJournal } from '../src/mutation-journal.js';
import { releaseHint } from '../src/hint-attempt.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
const items: PublicTypes['TimelineEvent'][] = JSON.parse(
  readFileSync(new URL('../../../packages/contracts/examples/timeline.json', import.meta.url), 'utf8'),
).items;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('timeline deduplicates reconnect history, keeps completed commands, and bounds retained rows', () => {
  const command = items.find((event) => event.kind === 'command')!;
  const pending = { ...command, endedAt: null };
  assert.equal(
    mergeTimeline(items, [pending as PublicTypes['TimelineEvent']]).find((event) => event.id === command.id)?.kind,
    'command',
  );
  assert.equal(mergeTimeline(items, [command]).length, items.length);
  assert.equal(new Set(mergeTimeline(items, [command]).map((event) => event.id)).size, items.length);
  assert.equal(mergeTimeline(items, items, 3).length, 3);
  assert.deepEqual(
    mergeTimeline(items, [pending as PublicTypes['TimelineEvent']]).find((event) => event.id === command.id),
    command,
  );
});
test('metric timestamps advance monotonically and missing data never becomes zero or fresh', () => {
  const current = { at: '2026-10-16T00:00:05Z', values: { error_rate: 27 } };
  const old = { at: '2026-10-16T00:00:00Z', values: { cpu: 10 } };
  assert.equal(mergeSamples([current], old).at(-1), current);
  assert.equal(mergeSamples([current], old, 1).length, 1);
  assert.equal(freshSample(current, Date.parse(current.at) + 16000, true), false);
  assert.equal(freshSample(current, Date.parse(current.at) + 1000, false), false);
  assert.equal(freshSample(undefined, Date.now(), true), false);
  assert.equal(current.values['cpu' as keyof typeof current.values], undefined);
});
test('timeline catch-up follows durable cursors, survives an empty live page, and resets stale cursors', async () => {
  const controller = new AbortController();
  let calls = 0;
  const urls: string[] = [],
    seen: PublicTypes['TimelineEvent'][][] = [];
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (url) => {
      urls.push(String(url));
      calls++;
      if (calls === 3)
        return new Response(JSON.stringify({ code: 'INVALID_CURSOR', message: 'Cursor stale', requestId: id }), {
          status: 400,
        });
      return new Response(
        JSON.stringify({ items: calls === 2 ? [] : [items[0]], nextCursor: calls === 4 ? null : 'cursor-one' }),
      );
    },
  );
  await observeTimeline(
    api,
    id,
    controller.signal,
    (rows) => seen.push(rows),
    async () => {
      if (calls === 4) controller.abort();
    },
  );
  assert.match(urls[1]!, /cursor=cursor-one/);
  assert.match(urls[2]!, /cursor=cursor-one/);
  assert.doesNotMatch(urls[3]!, /cursor=/);
  assert.deepEqual(seen[1], []);
  assert.equal(calls, 4);
});
test('lost hint responses recover the same receipt, while a definite cooldown rejection permits a new request', async () => {
  const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
  let calls = 0;
  const ids: string[] = [];
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (_url, request) => {
      const requestId = JSON.parse(String(request?.body)).requestId;
      ids.push(requestId);
      calls++;
      if (calls === 1) throw new Error('connection lost');
      if (calls === 3)
        return new Response(
          JSON.stringify({ code: 'HINT_NOT_AVAILABLE', message: 'Wait', requestId, retryAfterSeconds: 3 }),
          { status: 409 },
        );
      return new Response(
        JSON.stringify({
          hint: { id: 'hint-1', text: 'Inspect the proxy logs.', releasedAt: '2026-10-16T00:00:00Z' },
          remaining: 1,
          replayed: calls === 2,
        }),
      );
    },
  );
  await assert.rejects(releaseHint(api, journal, id), TransportError);
  await releaseHint(api, journal, id);
  assert.equal(ids[0], ids[1]);
  await assert.rejects(releaseHint(api, journal, id));
  assert.equal(journal.load('hint', `/v1/sessions/${id}/hints`), null);
  await releaseHint(api, journal, id);
  assert.notEqual(ids[2], ids[3]);
});
