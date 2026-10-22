import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BriefingContent, AttemptRules } from '../src/components/challenge-briefing.js';
import { parsePublic } from '../../../packages/contracts/public-validation.js';

test('the same safe briefing renders service locations and read-only guidance without service contents', async () => {
  const briefing = await parsePublic(
    'ChallengeBriefing',
    JSON.parse(
      readFileSync(new URL('../../../packages/contracts/examples/challenge-briefing.json', import.meta.url), 'utf8'),
    ),
  );
  const html = renderToStaticMarkup(createElement(BriefingContent, { briefing }));
  assert.match(html, /\/var\/log\/nginx\/error\.log/);
  assert.match(html, /\/etc\/shop\/gunicorn\.conf\.py/);
  assert.match(html, /ss -ltnp/);
  assert.doesNotMatch(html, /8081|proxy_pass|sed -i|referenceFix|validators|rootCause/);
  const hostile = renderToStaticMarkup(
    createElement(BriefingContent, {
      briefing: { ...briefing, overview: '<script>alert(1)</script>' },
    }),
  );
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;/);
});

test('before-start rules state clock, abandonment and recording semantics', () => {
  const html = renderToStaticMarkup(createElement(AttemptRules));
  assert.match(html, /clock starts when the environment is ready/);
  assert.match(html, /does not pause/);
  assert.match(html, /within five minutes/);
  assert.match(html, /recorded for your debrief/);
});
