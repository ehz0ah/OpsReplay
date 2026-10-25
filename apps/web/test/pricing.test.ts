import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { PricingPage } from '../src/pages/pricing.js';

test('pricing distinguishes the proposal, demo activation and actual access value', () => {
  const html = renderToStaticMarkup(createElement(MantineProvider, null, createElement(PricingPage)));
  assert.match(html, /Presentation prototype/);
  assert.match(html, /Prices below are proposed/);
  assert.match(html, /takes no payment/);
  assert.match(html, /does not renew/);
  assert.match(html, /S\$12/);
  assert.match(html, /S\$0/);
  assert.match(html, /Full Challenge debrief and recorded playback/);
  assert.match(html, /first result preserved/);
  assert.match(html, /current library is small/);
  assert.match(html, /unlimited runtime is not promised/);
  assert.match(html, /Class management and real billing are not available/);
  assert.doesNotMatch(html, /<input|Subscribe now|payment succeeded|1000 concurrent|Guaranteed/);
});
