import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { ApiClient, ApiError, TransportError } from '../src/api.js';
import { observeSession, retryDelay, timeRemaining, terminal } from '../src/lifecycle.js';
import { endAttempt } from '../src/end-attempt.js';
import { MutationJournal } from '../src/mutation-journal.js';
const view = JSON.parse(
  readFileSync(new URL('../../../packages/contracts/examples/session.json', import.meta.url), 'utf8'),
);
test('polling is serial, survives throttling, and stops after the saved outcome and debrief', async () => {
  let calls = 0,
    active = 0;
  const states: string[] = [],
    delays: number[] = [];
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () => {
      assert.equal(++active, 1);
      active--;
      if (++calls === 1)
        return new Response(
          JSON.stringify({
            code: 'LIMIT_EXCEEDED',
            message: 'Throttled',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            retryAfterSeconds: 2,
          }),
          { status: 429 },
        );
      return new Response(
        JSON.stringify(
          calls === 2
            ? view
            : {
                ...view,
                status: 'ended',
                statusReason: 'learner_ended',
                endedAt: new Date(Date.parse(view.readyAt ?? view.createdAt) + 1000).toISOString(),
                debriefAvailable: true,
              },
        ),
      );
    },
  );
  await observeSession(
    api,
    view.id,
    new AbortController().signal,
    (value) => {
      if (value) states.push(value.status);
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.equal(calls, 3);
  assert.ok(delays[0]! >= 2000);
  assert.deepEqual(states, [view.status, 'ended']);
});
test('elapsed browser time does not decide a terminal outcome, and retry delays remain bounded', () => {
  const expired = { ...view, endsAt: '2026-01-01T00:00:00Z' };
  assert.equal(timeRemaining(expired, Date.now()), 0);
  assert.equal(terminal('ready'), false);
  assert.equal(
    retryDelay(
      new ApiError(429, {
        code: 'LIMIT_EXCEEDED',
        message: 'Wait',
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        retryAfterSeconds: 3,
      }),
      1,
      () => 0,
    ),
    3000,
  );
  assert.ok(retryDelay(new Error(), 100, () => 0.99) <= 30000);
});
test('end recovery preserves its request ID across uncertain delivery and accepts the actual response envelope', async () => {
  const storage = new InMemoryWebStorage(),
    journal = new MutationJournal(storage, 'learner');
  let id: string | undefined;
  let calls = 0;
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      id ??= request.requestId;
      assert.equal(request.requestId, id);
      if (++calls === 1) throw new Error('lost response');
      return new Response(
        JSON.stringify({
          session: {
            ...view,
            status: 'ended',
            statusReason: 'learner_ended',
            endedAt: new Date(Date.parse(view.readyAt ?? view.createdAt) + 1000).toISOString(),
          },
        }),
      );
    },
  );
  await assert.rejects(endAttempt(api, journal, view.id), TransportError);
  await endAttempt(api, new MutationJournal(storage, 'learner'), view.id);
  assert.equal(journal.load('end', `/v1/sessions/${view.id}/end`), null);
});
