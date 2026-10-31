import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { ApiClient } from '../src/api.js';
import { ChallengeAdmission } from '../src/components/challenge-admission.js';
import { MutationJournal, type PendingMutation } from '../src/mutation-journal.js';
import { startAttempt } from '../src/start-attempt.js';

const request: PendingMutation & { kind: 'start' } = {
  kind: 'start',
  path: '/v1/sessions',
  body: {
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    challengeId: 'wrong-upstream-port',
    challengeVersion: '0.1.2',
  },
};
test('closed admission sends no start request and creates no pending mutation', async () => {
  const storage = new InMemoryWebStorage(),
    journal = new MutationJournal(storage, 'learner');
  let sends = 0;
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () => {
      sends++;
      throw new Error('Unexpected request');
    },
  );
  await assert.rejects(startAttempt(api, journal, request, false), /temporarily unavailable/);
  assert.equal(sends, 0);
  assert.equal(journal.load('start', '/v1/sessions'), null);
});
test('closed admission preserves an uncertain request and reopening recovers its exact original identity', async () => {
  const storage = new InMemoryWebStorage(),
    journal = new MutationJournal(storage, 'learner');
  journal.begin(request);
  let sends = 0;
  const response = JSON.parse(
    readFileSync(new URL('../../../packages/contracts/examples/response-examples.json', import.meta.url), 'utf8'),
  ).SessionResponse[0];
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (_url, options) => {
      sends++;
      assert.deepEqual(JSON.parse(String(options?.body)), request.body);
      return new Response(JSON.stringify(response));
    },
  );
  await assert.rejects(startAttempt(api, journal, request, false), /temporarily unavailable/);
  assert.deepEqual(journal.load('start', '/v1/sessions'), request);
  assert.equal(sends, 0);
  const session = await startAttempt(api, new MutationJournal(storage, 'learner'), request, true);
  assert.equal(session.id, response.session.id);
  assert.equal(sends, 1);
  assert.equal(journal.load('start', '/v1/sessions'), null);
});
test('availability feedback explains usable modes and preserved attempts without claiming they stopped', () => {
  const html = renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(ChallengeAdmission, { refresh: () => {} })),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /temporarily unavailable/);
  assert.match(html, /Learn and Code Review/);
  assert.match(html, /existing attempt/);
  assert.match(html, /Pro access does not change/);
  assert.match(html, /Check availability/);
  assert.doesNotMatch(html, /Your attempt has ended|No task started/);
});
