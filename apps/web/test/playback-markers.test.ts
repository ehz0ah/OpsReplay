import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chartCommands, inPlaybackRange, type RecordedCommand } from '../src/playback/markers.js';
import { Metric } from '../src/components/metric.js';
import { Timeline } from '../src/components/timeline.js';
const start = Date.parse('2026-10-18T00:00:00Z'),
  range = { start, end: start + 60000 };
const command = (seq: number, offset = seq * 1000): RecordedCommand => ({
  kind: 'command',
  id: 'command-' + seq,
  seq,
  at: new Date(start + offset).toISOString(),
  endedAt: new Date(start + offset + 100).toISOString(),
  command: 'echo <script>',
  exitStatus: 0,
  source: 'learner',
  changedFiles: [],
  outputExcerpt: '<script>alert(1)</script>',
  outputTruncated: true,
  metrics: null,
});
const descriptor = { id: 'error_rate', label: 'Errors', unit: 'percent' } as const;
test('chart marker count is bounded, preserves an older selection, and excludes outside-range commands', () => {
  const commands = Array.from({ length: 150 }, (_, n) => command(n + 1, n));
  const markers = chartCommands([...commands, command(200, 90000)], range, 'command-1');
  assert.equal(markers.length, 120);
  assert.equal(markers[0]?.id, 'command-1');
  assert.ok(!markers.some((value) => value.seq === 200));
  assert.equal(inPlaybackRange(command(1, 0), range), true);
  assert.equal(inPlaybackRange(command(1, 60000), range), true);
  assert.equal(inPlaybackRange(command(1, -1), range), false);
  assert.equal(inPlaybackRange(command(1), null), false);
});
test('playback charts use a stable time range, accessible markers and preserve missing-data gaps', () => {
  const samples = [0, 5000, 10000, 15000, 40000].map((offset, index) => ({
    at: new Date(start + offset).toISOString(),
    values: index === 2 ? {} : { error_rate: index },
  }));
  const html = renderToStaticMarkup(
    createElement(Metric, {
      descriptor,
      samples,
      playback: {
        range,
        at: start + 40000,
        commands: [command(1, 30000)],
        selectedId: 'command-1',
        onSelect: () => {},
      },
    }),
  );
  assert.equal((html.match(/<polyline/g) ?? []).length, 3);
  assert.match(html, /role="group"/);
  assert.match(html, /role="button" tabindex="0"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /cx="162.5"/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /echo &lt;script&gt;/);
  const empty = renderToStaticMarkup(
    createElement(Metric, {
      descriptor,
      samples: [],
      playback: {
        range: { start, end: start },
        at: start,
        commands: [command(1, 0)],
        selectedId: null,
        onSelect: () => {},
      },
    }),
  );
  assert.ok(!empty.includes('NaN'));
  assert.match(empty, /Unavailable/);
  assert.match(empty, /role="button"/);
});
test('timeline exposes every loaded command and disables seeks outside loaded metadata', () => {
  const html = renderToStaticMarkup(
    createElement(Timeline, {
      items: [command(1), command(2, 90000)],
      playback: { range, selectedId: 'command-1', onSelect: () => {} },
    }),
  );
  assert.equal((html.match(/class="timeline-seek"/g) ?? []).length, 2);
  assert.match(html, /disabled=""/);
  assert.match(html, /Outside loaded playback range/);
  assert.match(html, /Output excerpt truncated/);
  assert.ok(!html.includes('<script>'));
  const plain = renderToStaticMarkup(createElement(Timeline, { items: [command(1)] }));
  assert.ok(!plain.includes('timeline-seek'), 'Live timeline retains its existing behaviour');
});
test('chart marker buttons invoke selection for mouse, Enter and Space without executing a command', () => {
  const selected: RecordedCommand[] = [],
    item = command(1);
  const tree = Metric({
    descriptor,
    samples: [],
    playback: { range, at: start, commands: [item], selectedId: null, onSelect: (value) => selected.push(value) },
  });
  const find = (node: unknown): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    }
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props?.className === 'command-marker') return props;
    return find(props?.children);
  };
  const props = find(tree)!;
  (props.onClick as () => void)();
  let prevented = 0;
  const key = props.onKeyDown as (event: { key: string; preventDefault(): void }) => void;
  for (const value of ['Enter', ' ', 'ArrowRight'])
    key({
      key: value,
      preventDefault: () => {
        prevented++;
      },
    });
  assert.deepEqual(selected, [item, item, item]);
  assert.equal(prevented, 2);
});
