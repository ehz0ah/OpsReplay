import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const directory = new URL('../docs/evaluation/pilot/', import.meta.url);
const read = (file) => readFileSync(new URL(file, directory), 'utf8');
test('pilot assignments cover both incidents and condition orders without a repeated incident', () => {
  const lines = read('assignments.csv').trim().split('\n');
  const rows = lines.slice(1).map((line) => line.split(','));
  assert.equal(rows.length, 10);
  assert.equal(new Set(rows.map((r) => r[0])).size, 10);
  const assignments = new Set();
  for (const row of rows) {
    assert.equal(row.length, 5);
    assert.match(row[0], /^P(0[1-9]|10)$/);
    assert.notEqual(row[1], row[3]);
    assert.deepEqual([row[2], row[4]].sort(), ['interactive', 'static']);
    assert.deepEqual([row[1], row[3]].sort(), ['stale-dns-record', 'wrong-upstream-port']);
    assignments.add(row.slice(1).join(','));
  }
  assert.equal(assignments.size, 4);
});
test('static materials match the pinned authored fault and sustain period', () => {
  for (const [incident, file] of [
    ['wrong-upstream-port', 'static-upstream.md'],
    ['stale-dns-record', 'static-dns.md'],
  ]) {
    const manifest = JSON.parse(
      readFileSync(new URL(`../content/challenges/${incident}/challenge.json`, import.meta.url)),
    );
    const text = read(file);
    assert.ok(text.includes(manifest.version));
    assert.ok(manifest.validators.every((v) => v.sustainSeconds === 60));
    assert.match(text, /60 consecutive/);
    for (const command of manifest.referenceFix.commands)
      assert.ok(text.includes(command), 'Reference recovery changed: ' + incident);
  }
});
test('result template has no invented measurements and only pseudonymous identity', () => {
  const value = JSON.parse(read('result-template.json'));
  assert.equal(value.consent, null);
  assert.equal(value.susScore, null);
  assert.equal(value.susResponses.length, 10);
  assert.ok(value.susResponses.every((v) => v === null));
  for (const condition of value.conditions) {
    assert.equal(condition.completed, null);
    assert.equal(condition.baselineScores, null);
    assert.equal(condition.postScores, null);
    assert.equal(condition.transferScores, null);
  }
  assert.equal(
    Object.keys(value).some((k) => /email|name|token|sessionId|ownerId/i.test(k)),
    false,
  );
});
