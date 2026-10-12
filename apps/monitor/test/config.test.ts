import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../../../content/challenges/wrong-upstream-port/challenge.json';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';
import { endpoint, parseConfig } from '../src/config.js';
import { limits } from '../src/types.js';

test('manifest validation projects only execution configuration', () => {
  const config = parseConfig(JSON.stringify(manifest));
  assert.equal(config.journeys[0]!.ratePerSecond, 2);
  assert.equal(config.validators[0]!.sustainSeconds, 60);
  assert.deepEqual(Object.keys(config).sort(), ['journeys', 'probes', 'startupChecks', 'validators', 'watched']);
  assert.deepEqual(config.startupChecks, manifest.startupChecks);
  assert.ok(!JSON.stringify(config).includes(manifest.plantedFault.summary));
});

test('startup checks are optional for existing manifests and never become ongoing probes', () => {
  const { startupChecks, ...legacy } = structuredClone(manifest);
  assert.equal(startupChecks.length, 2);
  assert.deepEqual(parseConfig(JSON.stringify(legacy)).startupChecks, []);
  const config = parseConfig(JSON.stringify(manifest));
  assert.deepEqual(config.probes, manifest.healthProbes);
  assert.deepEqual(config.validators, manifest.validators);
});

test('startup checks accept only bounded canonical loopback TCP targets', () => {
  const check = manifest.startupChecks[0]!;
  for (const startupChecks of [
    [],
    null,
    [check, check],
    Array.from({ length: 11 }, (_, index) => ({ ...check, port: 8000 + index })),
    [{ ...check, kind: 'http' }],
    [{ ...check, host: '169.254.170.2' }],
    [{ ...check, host: 'localhost' }],
    [{ ...check, host: '127.0.0.999' }],
    [{ ...check, host: '127.0.0.01' }],
    [{ ...check, port: 0 }],
    [{ ...check, port: 65536 }],
    [{ ...check, port: 8080.5 }],
    [{ ...check, timeoutMs: 99 }],
    [{ ...check, timeoutMs: 1001 }],
    [{ ...check, extra: 'private-content' }],
  ]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...manifest, startupChecks })), /^MonitorError: invalid_config$/);
  }
  const startupChecks = Array.from({ length: 10 }, (_, index) => ({
    ...check,
    host: '127.0.0.2',
    port: 8000 + index,
    timeoutMs: 100,
  }));
  assert.deepEqual(parseConfig(JSON.stringify({ ...manifest, startupChecks })).startupChecks, startupChecks);
});

test('invalid or oversized input has a fixed error without the private content', () => {
  for (const input of ['hidden-root-cause', '{}', ' '.repeat(262145)]) {
    assert.throws(() => parseConfig(input), /^MonitorError: invalid_config$/);
  }
});

test('duplicates, unknown references, unsupported checks, and overload fail admission', () => {
  const cases = [
    (m: typeof manifest) => {
      m.traffic.journeys.push(m.traffic.journeys[0]!);
    },
    (m: typeof manifest) => {
      m.validators.push(m.validators[0]!);
    },
    (m: typeof manifest) => {
      m.healthProbes.push(m.healthProbes[0]!);
    },
    (m: typeof manifest) => {
      m.validators[0]!.check.journey = 'missing';
    },
    (m: typeof manifest) => {
      m.validators[0]!.check.kind = 'unknown';
    },
    (m: typeof manifest) => {
      m.traffic.journeys[0]!.ratePerSecond = 50;
    },
    (m: typeof manifest) => {
      m.traffic.journeys[0]!.steps[0]!.timeoutMs = 30000;
    },
    (m: typeof manifest) => {
      m.traffic.journeys[0]!.steps[0]!.url = 'http://169.254.170.2/credentials';
    },
  ];
  for (const change of cases) {
    const copy = structuredClone(manifest);
    change(copy);
    assert.throws(() => parseConfig(JSON.stringify(copy)), /invalid_config/);
  }
});

test('admission covers the public session maximum and recording headroom', () => {
  assert.equal(limits.maxSessionMs, publicSchema.$defs.SessionView.properties.timeLimitSeconds.maximum * 1000);
  const copy = structuredClone(manifest);
  copy.environment.timeLimitMinutes = 120;
  copy.traffic.journeys[0]!.ratePerSecond = 5;
  for (const step of copy.traffic.journeys[0]!.steps) step.timeoutMs = 100;
  assert.deepEqual(parseConfig(JSON.stringify(copy)), {
    journeys: copy.traffic.journeys,
    validators: copy.validators,
    probes: copy.healthProbes,
    startupChecks: copy.startupChecks,
    watched: {
      configs: copy.environment.services.flatMap((service) => service.configFiles),
      logs: copy.environment.services.flatMap((service) => service.logFiles),
    },
  });

  copy.traffic.journeys[0]!.ratePerSecond = 6;
  assert.throws(() => parseConfig(JSON.stringify(copy)), /invalid_config/);

  const boundary = structuredClone(manifest);
  boundary.traffic.journeys[0]!.ratePerSecond = 1.0373;
  boundary.traffic.journeys[0]!.steps = Array.from({ length: 10 }, () => ({
    ...structuredClone(manifest.traffic.journeys[0]!.steps[0]!),
    timeoutMs: 1,
  }));
  assert.throws(() => parseConfig(JSON.stringify(boundary)), /invalid_config/);

  const validators = structuredClone(manifest);
  validators.validators = Array.from({ length: 7 }, (_, index) => ({
    ...structuredClone(manifest.validators[index % manifest.validators.length]!),
    id: `validator-${index}`,
  }));
  assert.throws(() => parseConfig(JSON.stringify(validators)), /invalid_config/);
});

test('network targets are canonical authored loopback URLs only', () => {
  for (const url of ['http://127.0.0.1/', 'http://127.0.0.2:8080/orders?a=b']) {
    assert.equal(endpoint(url).hostname.startsWith('127.0.0.'), true);
  }
  for (const url of [
    'http://localhost/',
    'http://127.1/',
    'http://2130706433/',
    'http://127.0.0.999/',
    'http://127.0.0.01/',
    'http://127.0.0.1:0/',
    'http://127.0.0.1:65536/',
    'http://127.0.0.1@evil.example/',
    'http://user:secret@127.0.0.1/',
    'https://127.0.0.1/',
    'http://127.0.0.1/#secret',
    'http://127.0.0.1/\n',
  ]) {
    assert.throws(() => endpoint(url), /invalid_config/, url);
  }
});
