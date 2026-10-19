import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ReviewAttempt } from '../src/review-attempt.js';
import { ApiClient, TransportError } from '../src/api.js';
import { exerciseView, reviewResult } from '../../../packages/content/src/review.js';
import { parsePublic } from '../../../packages/contracts/public-validation.js';
const bundle = JSON.parse(
  readFileSync(new URL('../../../content/reviews/proxy-rollout/review.json', import.meta.url), 'utf8'),
);
test('lost review response retains the original request and a different learner cannot recover it', async () => {
  const storage = new InMemoryWebStorage();
  const attempt = new ReviewAttempt(storage, 'owner', bundle.id);
  const request = attempt.begin(bundle.version, []);
  let calls = 0;
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async (_url, options) => {
      const sent = JSON.parse(String(options?.body));
      assert.equal(sent.requestId, request.requestId);
      if (++calls === 1) throw new Error('offline');
      return new Response(
        JSON.stringify({
          id: randomUUID(),
          exerciseId: bundle.id,
          exerciseVersion: bundle.version,
          submittedAt: new Date().toISOString(),
          answerInformed: false,
          replayed: true,
          flags: [],
          ...reviewResult(bundle, []),
        }),
      );
    },
  );
  await assert.rejects(attempt.submit(api, request), TransportError);
  assert.deepEqual(new ReviewAttempt(storage, 'owner', bundle.id).load(), request);
  assert.equal(new ReviewAttempt(storage, 'other', bundle.id).load(), null);
  await attempt.submit(api, request);
  assert.equal(attempt.load(), null);
});
test('browser rejects findings in an exercise response before submission', async () => {
  await parsePublic('ReviewExercise', exerciseView(bundle));
  await assert.rejects(parsePublic('ReviewExercise', { ...exerciseView(bundle), findings: bundle.findings }));
});

test('definite invalid submission clears its pending request, uncertain errors do not', async () => {
  const storage = new InMemoryWebStorage(),
    attempt = new ReviewAttempt(storage, 'owner', bundle.id);
  const request = attempt.begin(bundle.version, []);
  const api = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () =>
      new Response(
        JSON.stringify({
          code: 'INVALID_REQUEST',
          message: 'Invalid line.',
          requestId: request.requestId,
        }),
        { status: 400 },
      ),
  );
  await assert.rejects(attempt.submit(api, request));
  assert.equal(attempt.load(), null);
});
