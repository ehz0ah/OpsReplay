import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { FileCaptures } from '../src/captures.js';

// Descriptor-anchored reads use Linux /proc. Real reads and link attacks are
// exercised by the Monitor image test, not emulated on macOS.
test('rejects untrusted paths and duplicate allowlist entries before any read', () => {
  for (const configs of [['/../secret'], ['/etc/./secret'], ['/etc/a', '/etc/a'], ['relative']]) {
    assert.throws(() => new FileCaptures({ configs, logs: [] }), /invalid_config/);
  }
});

test('capture requires a baseline and rejects a changed duplicate identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'opsreplay-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captures = new FileCaptures({ configs: [], logs: [] }, root);
  const request = { commandId: randomUUID(), commandSeq: 1 };
  await assert.rejects(captures.capture(request), /invalid_boundary/);
  const baseline = await captures.baseline();
  const [first, second] = await Promise.all([captures.capture(request), captures.capture(request)]);
  assert.deepEqual(first, second);
  assert.equal(first.sequence, 1);
  assert.equal(first.baselineAt, baseline.baselineAt);
  await assert.rejects(captures.capture({ ...request, commandSeq: 2 }), /invalid_boundary/);
  first.logs.push({ path: '/fake', lines: [] });
  assert.equal((await captures.capture(request)).logs.length, 0);
});

test(
  'Linux read capture preserves interval starts, new lines, and changed blocks',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'opsreplay-capture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'etc'));
    await writeFile(join(root, 'etc/config'), 'before');
    await writeFile(join(root, 'etc/log'), 'old\n');
    let tick = 0;
    const captures = new FileCaptures(
      { configs: ['/etc/config'], logs: ['/etc/log'] },
      root,
      () => new Date(1000 + tick++).toISOString(),
      () => ({ at: new Date(1000 + tick++).toISOString(), values: { request_rate: 1 } }),
    );
    const baseline = await captures.baseline();
    await writeFile(join(root, 'etc/config'), 'after');
    await appendFile(join(root, 'etc/log'), 'new\n');
    const first = await captures.capture({ commandId: randomUUID(), commandSeq: 1 });
    assert.deepEqual(first.files, [{ path: '/etc/config', before: 'before', after: 'after' }]);
    assert.deepEqual(first.logs, [{ path: '/etc/log', lines: ['new'] }]);
    assert.equal(first.incomplete, false);
    assert.equal(first.baselineAt, baseline.baselineAt);
    const next = await captures.capture({ commandId: randomUUID(), commandSeq: 2 });
    assert.equal(next.baselineAt, first.startedAt);
    assert.deepEqual(next.files, []);
    assert.deepEqual(next.logs, []);
  },
);
