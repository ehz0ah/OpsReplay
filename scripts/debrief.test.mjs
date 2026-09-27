import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { deriveDebrief, matchEvidence } from './reference/debrief.mjs';

const read = file => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
const challenge = read('content/challenges/wrong-upstream-port/challenge.json');
const timeline = read('packages/contracts/examples/timeline.json').items;
const commands = timeline.filter(item => item.kind === 'command');
const log = challenge.debrief.keyEvidence[0];

test('mentioning a log path does not prove its evidence was observed', () => {
  const echoed = { ...commands[1], command: 'echo /var/log/nginx/error.log', outputExcerpt: '/var/log/nginx/error.log' };
  assert.equal(matchEvidence(log, [echoed]).status, 'not_observed');
  // Even copied log text does not make echo a supported inspection command.
  assert.equal(matchEvidence(log, [{ ...echoed, outputExcerpt: commands[1].outputExcerpt }]).status, 'not_observed');
});

test('failed reads, empty output, and full-screen edits only record attempts', () => {
  for (const outputExcerpt of ['', 'tail: cannot open file: Permission denied', 'No matching entries']) {
    assert.equal(matchEvidence(log, [{ ...commands[1], exitStatus: 1, outputExcerpt }]).status, 'attempted');
  }
  const config = matchEvidence(challenge.debrief.keyEvidence[2], [commands[3]]);
  assert.equal(config.status, 'attempted');
  assert.equal(config.commandSeq, 4);
});

test('an actual saved output wins over an earlier failed attempt', () => {
  const result = matchEvidence(log, [{ ...commands[1], seq: 1, outputExcerpt: '' }, commands[1]]);
  assert.equal(result.status, 'observed');
  assert.equal(result.commandSeq, 2);
  assert.equal(matchEvidence(log, [{ ...commands[1], outputTruncated: true }]).status, 'observed');
});

test('an intervening pwd does not become an outage cause', () => {
  const pwd = { ...commands[0], id: 'intervening', seq: 10, at: '2026-10-05T02:04:21Z', endedAt: '2026-10-05T02:04:21Z', command: 'pwd', outputExcerpt: '/root' };
  const result = deriveDebrief(challenge, [...timeline, pwd]);
  assert.equal(result.possibleHarmfulActions.length, 1);
  assert.equal(result.possibleHarmfulActions[0].commandSeq, 5);
  assert.equal(result.possibleHarmfulActions[0].outageStartedAt, '2026-10-05T02:04:22Z');
  assert.equal('afterCommandSeq' in result.outages[0], false);
});

test('outages remain measured when there is no matching harmful command', () => {
  const events = timeline.filter(item => item.kind !== 'command' || item.seq !== 5);
  const result = deriveDebrief(challenge, events);
  assert.equal(result.possibleHarmfulActions.length, 0);
  assert.equal(result.observedOutages, 1);
  assert.equal(result.outageSeconds, 100);
});

test('equivalent time zones and fractional seconds preserve associations and durations', () => {
  const events = structuredClone(timeline);
  events.find(item => item.kind === 'command' && item.seq === 5).at = '2026-10-05T10:04:20+08:00';
  events.find(item => item.signal === 'outage_started').at = '2026-10-05T02:04:22.250Z';
  const result = deriveDebrief(challenge, events);
  assert.equal(result.possibleHarmfulActions.length, 1);
  assert.equal(result.outageSeconds, 99.75);
});

test('commands and observations after the first outcome are excluded', () => {
  const after = { ...commands[1], id: 'late', seq: 10, at: '2026-10-05T02:08:00Z', endedAt: '2026-10-05T02:08:01Z' };
  const result = deriveDebrief(challenge, [...timeline, after]);
  assert.equal(result.commandCount, commands.length);
  const straddling = structuredClone(timeline);
  straddling.find(item => item.kind === 'command' && item.seq === 2).endedAt = '2026-10-05T02:08:01Z';
  assert.equal(deriveDebrief(challenge, straddling).keyEvidence[0].status, 'attempted');
});

// Authored output examples, not results from running the draft images.
const cases = {
  'wrong-upstream-port': [
    [commands[1].command, commands[1].outputExcerpt],
    [commands[2].command, commands[2].outputExcerpt],
    ['cat /etc/nginx/nginx.conf', 'proxy_pass http://127.0.0.1:8081;'],
  ],
  'stale-dns-record': [
    ['tail /var/log/nginx/error.log', 'Connection refused while connecting to upstream 127.0.0.3:8080'],
    ['dig api.internal', 'api.internal. 60 IN A 127.0.0.3'],
    ['ss -ltnp', 'LISTEN 0 128 127.0.0.2:8080 0.0.0.0:*'],
    ['cat /etc/coredns/internal.db', 'api IN A 127.0.0.3'],
  ],
  'connection-exhaustion': [
    ['psql -c "SELECT state, query FROM pg_stat_activity"', 'active | SELECT * FROM orders WHERE user_id = 3'],
    ['psql -c "EXPLAIN SELECT * FROM orders"', 'Seq Scan on orders (cost=0.00..12000.00 rows=100 width=64)'],
    ['tail /var/log/shop/app.log', 'QueuePool limit of size 10 overflow 10 reached, connection timed out'],
    ['cat /etc/shop/shop.env', 'POOL_SIZE=10\nMAX_OVERFLOW=10'],
  ],
};
for (const [id, samples] of Object.entries(cases)) {
  test(id + ' evidence rules require relevant saved output', () => {
    const manifest = read('content/challenges/' + id + '/challenge.json');
    assert.equal(samples.length, manifest.debrief.keyEvidence.length);
    for (const [index, [command, outputExcerpt]] of samples.entries()) {
      const event = { ...commands[0], command, outputExcerpt };
      const rule = manifest.debrief.keyEvidence[index];
      assert.equal(matchEvidence(rule, [event]).status, 'observed', rule.id);
      assert.equal(matchEvidence(rule, [{ ...event, outputExcerpt: 'unrelated output' }]).status, 'attempted', rule.id);
    }
  });
}
