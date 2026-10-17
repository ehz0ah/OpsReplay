import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Metric } from '../src/components/metric.js';
const descriptor = { id: 'error_rate', label: 'Errors', unit: 'percent' } as const;
test('metric chart preserves missing samples and time gaps instead of drawing false continuity', () => {
  const samples = [
    { at: '2026-10-18T00:00:00Z', values: { error_rate: 100 } },
    { at: '2026-10-18T00:00:05Z', values: { error_rate: 90 } },
    { at: '2026-10-18T00:00:10Z', values: {} },
    { at: '2026-10-18T00:00:15Z', values: { error_rate: 80 } },
    { at: '2026-10-18T00:01:00Z', values: { error_rate: 0 } },
    { at: '2026-10-18T00:01:05Z', values: {} },
  ];
  const html = renderToStaticMarkup(createElement(Metric, { descriptor, samples }));
  assert.equal((html.match(/<polyline/g) ?? []).length, 3);
  assert.match(html, /<strong>Unavailable<\/strong>/);
  assert.match(html, /<caption>Errors/);
  assert.equal((html.match(/<td>Unavailable<\/td>/g) ?? []).length, 2);
  assert.match(html, /<td>0<\/td>/);
});
test('sample table remains bounded and source labels are escaped', () => {
  const samples = Array.from({ length: 100 }, (_, n) => ({
    at: new Date(n * 5000).toISOString(),
    values: { error_rate: n },
  }));
  const html = renderToStaticMarkup(
    createElement(Metric, { descriptor: { ...descriptor, label: '<script>alert(1)</script>' }, samples }),
  );
  assert.equal((html.match(/<tr>/g) ?? []).length, 61);
  assert.match(html, /Latest 60 samples/);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
