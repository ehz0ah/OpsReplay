import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareReferenceRelease, assertBuildManifest } from '../src/release.js';
import { referenceIdentity, referenceTask } from './reference-fixture.js';
const build = JSON.parse(
  readFileSync(new URL('../../../content/challenges/stale-dns-record/challenge.json', import.meta.url), 'utf8'),
);
function dnsTask() {
  const task = referenceTask();
  task.family = 'opsreplay-stale-dns-record';
  task.taskDefinitionArn = task.taskDefinitionArn!.replace('wrong-upstream-port', 'stale-dns-record');
  task.containerDefinitions![0]!.image = task.containerDefinitions![0]!.image!.replace(
    'wrong-upstream-port',
    'stale-dns-record',
  );
  return task;
}
test('DNS release uses its own pinned task and public descriptors while keeping truth private', () => {
  const release = prepareReferenceRelease(build, referenceIdentity, dnsTask(), 1800);
  assert.equal(release.manifest.id, 'stale-dns-record');
  assert.equal(release.admission.challenge.id, 'stale-dns-record');
  assert.equal(release.admission.plan, 'pro');
  assert.equal(release.admission.timeLimits.free, 1500);
  assert.match(release.admission.pins.taskDefinitionArn, /opsreplay-stale-dns-record:42$/);
  assert.deepEqual(
    release.admission.dashboard.map((d) => d.id),
    ['request_rate', 'error_rate', 'latency_p95'],
  );
  for (const hidden of ['rootCause', 'plantedFault', 'internal.db', '127.0.0.3', 'validators', 'referenceFix'])
    assert.ok(!JSON.stringify(release.admission).includes(hidden));
});
test('DNS publication rejects another challenge task, repository substitution and unsupported measurements', () => {
  assert.throws(() => prepareReferenceRelease(build, referenceIdentity, referenceTask(), 1800));
  const changed = structuredClone(build);
  changed.environment.image.repository = 'opsreplay/challenge-wrong-upstream-port';
  assert.throws(() => assertBuildManifest(changed));
  const metric = structuredClone(build);
  metric.dashboard.push({ id: 'cpu', label: 'CPU', unit: 'percent', source: 'cpu' });
  assert.throws(() => assertBuildManifest(metric));
  const unknown = structuredClone(build);
  unknown.id = 'unknown';
  unknown.environment.image.repository = 'opsreplay/challenge-unknown';
  assert.throws(() => assertBuildManifest(unknown));
});
