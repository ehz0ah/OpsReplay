import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShellMarkerFilter } from '../src/shell-marker-filter.js';
test('strips shell markers across every byte split and preserves other output', () => {
  const input = Buffer.from('a\x1b]133;C;c2VjcmV0\x07b\x1b]0;title\x07\x1b[31m中\x1b]133;D;0\x1b\\c');
  const expected = Buffer.from('ab\x1b]0;title\x07\x1b[31m中c');
  for (let split = 0; split <= input.length; split++) {
    const filter = new ShellMarkerFilter();
    assert.deepEqual(
      Buffer.concat([filter.write(input.subarray(0, split)), filter.write(input.subarray(split))]),
      expected,
    );
  }
  const filter = new ShellMarkerFilter();
  assert.deepEqual(Buffer.concat([...input].map((byte) => filter.write(Buffer.from([byte])))), expected);
});
test('unterminated and very large shell markers have constant retained state', () => {
  const filter = new ShellMarkerFilter();
  assert.deepEqual(filter.write(Buffer.from('\x1b]133;C;' + 'x'.repeat(500000))), Buffer.alloc(0));
  assert.deepEqual(filter.write(Buffer.from('\x07plain')), Buffer.from('plain'));
  assert.deepEqual(filter.write(Buffer.from('\x1b\x1b[1m')), Buffer.from('\x1b\x1b[1m'));
});
