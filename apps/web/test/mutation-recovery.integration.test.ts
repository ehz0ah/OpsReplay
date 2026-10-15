import { readFileSync } from 'node:fs';
import { startAttempt } from '../src/start-attempt.js';
import { ApiClient } from '../src/api.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { MutationJournal, type PendingMutation } from '../src/mutation-journal.js';
import { ApiError, TransportError } from '../src/api.js';
const pending: PendingMutation = {
  kind: 'start',
  path: '/v1/sessions',
  body: {
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    challengeId: 'wrong-upstream-port',
    challengeVersion: '0.1.0',
  },
};
test('reload and duplicate start retain the exact request while different learners stay isolated', () => {
  const storage = new InMemoryWebStorage(),
    journal = new MutationJournal(storage, 'learner');
  journal.begin(pending);
  const reloaded = new MutationJournal(storage, 'learner');
  assert.equal(
    reloaded.begin({ ...pending, body: { ...pending.body, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }).body
      .requestId,
    pending.body.requestId,
  );
  assert.equal(new MutationJournal(storage, 'other').load('start', '/v1/sessions'), null);
  assert.throws(
    () => reloaded.begin({ ...pending, body: { ...pending.body, challengeId: 'another' } }),
    /previous request/,
  );
  reloaded.reject(pending, new TransportError());
  assert.deepEqual(reloaded.load('start', '/v1/sessions'), pending);
});
test('gateway throttling cannot discard an uncertain earlier mutation, but owned admission rejection can', () => {
  const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
  journal.begin(pending);
  journal.reject(
    pending,
    new ApiError(429, {
      code: 'LIMIT_EXCEEDED',
      message: 'Throttled',
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
  );
  assert.deepEqual(journal.load('start', '/v1/sessions'), pending);
  journal.reject(
    pending,
    new ApiError(403, { code: 'ACCESS_DENIED', message: 'Denied', requestId: pending.body.requestId }),
  );
  assert.equal(journal.load('start', '/v1/sessions'), null);
});

test('lost start response is recovered with the exact saved ID and only then clears the journal', async () => {
  const storage = new InMemoryWebStorage();
  let requests = 0;
  const response = JSON.parse(
    readFileSync(new URL('../../../packages/contracts/examples/response-examples.json', import.meta.url), 'utf8'),
  ).SessionResponse[0];
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (_url, options) => {
      assert.deepEqual(JSON.parse(String(options?.body)), pending.body);
      assert.deepEqual(new MutationJournal(storage, 'learner').load('start', '/v1/sessions'), pending);
      if (++requests === 1) throw new Error('lost response');
      return new Response(JSON.stringify({ ...response, replayed: true }));
    },
  );
  await assert.rejects(startAttempt(api, new MutationJournal(storage, 'learner'), pending), TransportError);
  const resumed = new MutationJournal(storage, 'learner');
  const result = await startAttempt(api, resumed, pending);
  assert.equal(result.id, response.session.id);
  assert.equal(resumed.load('start', '/v1/sessions'), null);
  assert.equal(requests, 2);
});
