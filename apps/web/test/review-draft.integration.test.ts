import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { exerciseView } from '../../../packages/content/src/review.js';
import { ReviewDraft } from '../src/review-draft.js';

const bundle = JSON.parse(
  readFileSync(new URL('../../../content/reviews/proxy-rollout/review.json', import.meta.url), 'utf8'),
);
const exercise = exerciseView(bundle);
const comment = { file: 'deploy.sh', side: 'new' as const, line: 4, concern: 'Validate first, then reload.' };

test('a remounted review restores saved comments and an unfinished edit without crossing learner or version boundaries', () => {
  const storage = new InMemoryWebStorage();
  const saved = { flags: [comment], editor: { ...comment, concern: 'Unfinished revision' }, editingIndex: 0 };
  new ReviewDraft(storage, 'learner', exercise).save(saved);
  assert.deepEqual(new ReviewDraft(storage, 'learner', exercise).load(), saved);
  assert.equal(new ReviewDraft(storage, 'another', exercise).load().flags.length, 0);
  assert.equal(new ReviewDraft(storage, 'learner', { ...exercise, version: '0.1.1' }).load().flags.length, 0);
  new ReviewDraft(storage, 'learner', exercise).clear();
  assert.deepEqual(new ReviewDraft(storage, 'learner', exercise).load(), {
    flags: [],
    editor: null,
    editingIndex: null,
  });
});

test('empty editor text survives refresh, while invalid lines and stale editing indices cannot overwrite the draft', () => {
  const storage = new InMemoryWebStorage(),
    store = new ReviewDraft(storage, 'learner', exercise);
  const saved = { flags: [], editor: { ...comment, concern: '' }, editingIndex: null };
  store.save(saved);
  assert.deepEqual(store.load(), saved);
  for (const value of [
    { flags: [{ ...comment, line: 99 }], editor: null, editingIndex: null },
    { flags: [{ ...comment, side: 'old' as const, line: 4 }], editor: null, editingIndex: null },
    { flags: [comment], editor: { ...comment, line: 3 }, editingIndex: 0 },
    { flags: [comment], editor: null, editingIndex: 0 },
    { flags: [comment], editor: comment, editingIndex: 1 },
    { flags: [], editor: { ...comment, concern: 'x'.repeat(2001) }, editingIndex: null },
  ])
    assert.throws(() => store.save(value));
  assert.deepEqual(store.load(), saved);
});

test('corrupt storage is rejected and preserved, and draft validation cannot bypass submission limits', () => {
  const storage = new InMemoryWebStorage(),
    store = new ReviewDraft(storage, 'learner', exercise);
  const key = `opsreplay:review-draft:learner:${exercise.id}@${exercise.version}`;
  storage.setItem(key, '{broken');
  assert.throws(() => store.load());
  assert.equal(storage.getItem(key), '{broken');
  storage.setItem(key, JSON.stringify({ flags: [], editor: { ...comment, concern: null }, editingIndex: null }));
  assert.throws(() => store.load());
  assert.throws(() =>
    store.save({ flags: Array.from({ length: 51 }, () => comment), editor: null, editingIndex: null }),
  );
});
