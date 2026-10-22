import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parsePublic } from '../../../packages/contracts/public-validation.js';
import { parseLesson } from '../../../packages/content/src/learn.js';
import { returnPath } from '../src/auth/session.js';
import { lessonCatalogueState, readFreeLesson } from '../src/learn.js';
const lesson = parseLesson(
  readFileSync(new URL('../../../content/learn/safe-incident-recovery.md', import.meta.url), 'utf8'),
  new Set(['challenge#wrong-upstream-port']),
);
test('Learn browser contract rejects private fields and free asset cannot serve Pro content', async () => {
  assert.equal((await parsePublic('LearnEntry', lesson)).id, lesson.id);
  await assert.rejects(parsePublic('LearnEntry', { ...lesson, plantedFault: 'hidden' }));
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url) =>
      String(url).endsWith('index.json')
        ? new Response(
            JSON.stringify([
              {
                id: lesson.id,
                version: lesson.version,
                title: lesson.title,
                category: lesson.category,
                summary: lesson.summary,
              },
            ]),
          )
        : new Response(JSON.stringify({ ...lesson, plan: 'pro' }));
    await assert.rejects(readFreeLesson(lesson.id, AbortSignal.timeout(1000)), /Invalid free lesson/);
    assert.equal(await readFreeLesson('not-published', AbortSignal.timeout(1000)), null);
  } finally {
    globalThis.fetch = previous;
  }
});

test('sign-in preserves only canonical Learn return paths', () => {
  assert.equal(returnPath('/learn/failover-and-data-integrity'), '/learn/failover-and-data-integrity');
  assert.equal(returnPath('/learn'), '/learn');
  assert.equal(returnPath('//evil.example'), '/');
  assert.equal(returnPath('/learn/../secret'), '/');
});

test('lesson source errors and unfinished reads cannot appear as an empty library', () => {
  assert.equal(lessonCatalogueState(0, true, null), 'loading');
  assert.equal(lessonCatalogueState(0, false, new Error('Asset request failed')), 'unavailable');
  assert.equal(lessonCatalogueState(1, false, new Error('Other source failed')), 'ready');
  assert.equal(lessonCatalogueState(0, false, null), 'empty');
});
