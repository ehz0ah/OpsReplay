import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../../../content/challenges/wrong-upstream-port/challenge.json';
import { endpoint, parseConfig } from '../src/config.js';

test('manifest validation projects only execution configuration', () => {
  const config = parseConfig(JSON.stringify(manifest));
  assert.equal(config.journeys[0]!.ratePerSecond, 2);
  assert.equal(config.validators[0]!.sustainSeconds, 60);
  assert.deepEqual(Object.keys(config).sort(), ['journeys', 'probes', 'validators']);
  assert.ok(!JSON.stringify(config).includes(manifest.plantedFault.summary));
});

test('invalid or oversized input has a fixed error without the private content', () => {
  for (const input of ['hidden-root-cause', '{}', ' '.repeat(262145)]) {
    assert.throws(() => parseConfig(input), /^MonitorError: invalid_config$/);
  }
});

test('duplicates, unknown references, unsupported checks, and overload fail admission', () => {
  const cases = [
    (m: typeof manifest) => { m.traffic.journeys.push(m.traffic.journeys[0]!); },
    (m: typeof manifest) => { m.validators.push(m.validators[0]!); },
    (m: typeof manifest) => { m.healthProbes.push(m.healthProbes[0]!); },
    (m: typeof manifest) => { m.validators[0]!.check.journey = 'missing'; },
    (m: typeof manifest) => { m.validators[0]!.check.kind = 'unknown'; },
    (m: typeof manifest) => { m.traffic.journeys[0]!.ratePerSecond = 50; },
    (m: typeof manifest) => { m.traffic.journeys[0]!.steps[0]!.timeoutMs = 30000; },
    (m: typeof manifest) => { m.traffic.journeys[0]!.steps[0]!.url = 'http://169.254.170.2/credentials'; },
  ];
  for (const change of cases) {
    const copy = structuredClone(manifest);
    change(copy);
    assert.throws(() => parseConfig(JSON.stringify(copy)), /invalid_config/);
  }
});

test('network targets are canonical authored loopback URLs only', () => {
  for (const url of ['http://127.0.0.1/', 'http://127.0.0.2:8080/orders?a=b']) {
    assert.equal(endpoint(url).hostname.startsWith('127.0.0.'), true);
  }
  for (const url of ['http://localhost/', 'http://127.1/', 'http://2130706433/',
    'http://127.0.0.999/', 'http://127.0.0.01/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/',
    'http://127.0.0.1@evil.example/', 'http://user:secret@127.0.0.1/',
    'https://127.0.0.1/', 'http://127.0.0.1/#secret', 'http://127.0.0.1/\n']) {
    assert.throws(() => endpoint(url), /invalid_config/, url);
  }
});
