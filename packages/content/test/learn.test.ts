import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseLesson, prepareLesson, renderLesson, sanitiseLessonHtml, isLearnRelease } from '../src/learn.js';
const file = new URL('../../../content/learn/safe-incident-recovery.md', import.meta.url);
const related = new Set(['challenge#wrong-upstream-port']);
test('original lessons render safe HTML and retain validated source and exercise metadata', () => {
  const entry = parseLesson(readFileSync(file, 'utf8'), related);
  assert.equal(entry.plan, 'free');
  assert.match(entry.html, /<h2>What happened<\/h2>/);
  const prepared = prepareLesson(entry);
  assert.ok(isLearnRelease(prepared.release));
  assert.equal(prepared.catalogue.mode, 'learn');
  assert.equal(prepareLesson(entry).release.sha256, prepared.release.sha256);
  assert.throws(() => parseLesson(readFileSync(file, 'utf8'), new Set()), /Unknown related/);
});
test('Markdown and publication reject active HTML and unsafe links', () => {
  const html = renderLesson('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n[good](https://example.com)');
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.equal(sanitiseLessonHtml('<p onclick="x()">ok</p><script>x()</script>'), '<p>ok</p>');
  const entry = parseLesson(readFileSync(file, 'utf8'), related);
  assert.throws(() => prepareLesson({ ...entry, html: '<img src=x onerror=alert(1)>' }), /Invalid lesson/);
  assert.throws(() => renderLesson('x'.repeat(128 * 1024 + 1)), /bound/);
});
test('metadata is strict and stored references cannot choose arbitrary objects', () => {
  assert.throws(() => parseLesson('plain markdown', related));
  const entry = parseLesson(readFileSync(file, 'utf8'), related);
  const reference = prepareLesson(entry).release;
  assert.equal(isLearnRelease({ ...reference, objectKey: 'sessions/other/secret' }), false);
  assert.equal(isLearnRelease({ ...reference, byteLength: 300000 }), false);
  assert.equal(isLearnRelease({ ...reference, unexpected: true }), false);
});

test('duplicate metadata keys and aliases fail instead of overriding access fields', () => {
  assert.throws(() => parseLesson('---\nid: one\nid: two\n---\nbody', related));
  assert.throws(() => parseLesson('---\nid: &name one\ntitle: *name\n---\nbody', related));
});
