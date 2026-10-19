import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePublic } from '../../../packages/contracts/public-validation.js';
import { returnPath } from '../src/auth/session.js';
import { randomUUID } from 'node:crypto';
test('history accepts canonical results and excludes private source fields', async () => {
  const item = {
    id: randomUUID(),
    challenge: {
      id: 'wrong-upstream-port',
      version: '0.1.0',
      title: 'Proxy failure',
      category: 'deployment',
      tier: 'easy',
    },
    attempt: { number: 1, kind: 'first' },
    status: 'ended',
    createdAt: '2026-10-20T00:00:00.000Z',
    endedAt: '2026-10-20T00:01:00.000Z',
  };
  await parsePublic('SessionPage', { items: [item], nextCursor: null });
  await assert.rejects(parsePublic('SessionPage', { items: [{ ...item, ownerId: 'private' }], nextCursor: null }));
  assert.equal(returnPath('/history'), '/history');
  assert.equal(returnPath('/review-submissions/' + item.id), '/review-submissions/' + item.id);
  assert.equal(returnPath('/history?owner=other'), '/');
});
