import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { attemptNotice } from '../src/components/attempt-notice.js';
import { WorkingState } from '../src/components/working-state.js';
import { HomePage } from '../src/pages/home.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';

const example: PublicTypes['SessionView'] = JSON.parse(
  readFileSync(new URL('../../../packages/contracts/examples/session.json', import.meta.url), 'utf8'),
);
test('outside-workspace feedback distinguishes provisioning, running, finalisation and failed startup', () => {
  assert.match(attemptNotice({ ...example, status: 'provisioning' }).detail, /clock starts when it is ready/);
  assert.match(attemptNotice({ ...example, status: 'ready' }).detail, /does not pause/);
  assert.equal(attemptNotice({ ...example, status: 'ready' }).action, 'Resume attempt');
  for (const status of ['resolved', 'failed', 'ended', 'abandoned', 'error'] as const) {
    const value = { ...example, status, readyAt: '2026-10-22T00:00:00Z', debriefAvailable: false };
    assert.equal(attemptNotice(value).action, 'View progress');
    assert.equal(attemptNotice({ ...value, debriefAvailable: true }).action, 'Open debrief');
  }
  assert.match(attemptNotice({ ...example, status: 'error', readyAt: null }).title, /did not start/);
});

test('working feedback has an accessible live status with text instead of relying only on animation', () => {
  const html = renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(WorkingState, { title: 'Preparing your debrief' }, 'Your recording is being saved.'),
    ),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /Preparing your debrief/);
  assert.match(html, /Your recording is being saved/);
});

test('home entry explains the real learner workflow without course branding or performance claims', () => {
  const html = renderToStaticMarkup(createElement(MantineProvider, null, createElement(HomePage)));
  assert.match(html, /Explore Challenges/);
  assert.match(html, /Read the briefing/);
  assert.match(html, /Investigate and repair/);
  assert.match(html, /Review your response/);
  assert.match(html, /does not pause the clock/);
  assert.doesNotMatch(html, /CS5224|NUS|1000 concurrent|guaranteed/);
});
