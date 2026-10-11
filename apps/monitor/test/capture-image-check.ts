// Linux security check. This entry point is excluded from the runtime target.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, symlink, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FileCaptures, readWatchedFile } from '../src/captures.js';

async function main() {
  const root = await mkdtemp('/tmp/capture-root-');
  const secretRoot = await mkdtemp('/tmp/capture-secret-');
  try {
    await mkdir(root + '/etc');
    await writeFile(root + '/etc/config', 'before');
    await writeFile(root + '/etc/log', 'old\n');
    await writeFile(secretRoot + '/secret', 'MONITOR_PRIVATE_SECRET');
    let time = 0;
    const captures = new FileCaptures(
      { configs: ['/etc/config'], logs: ['/etc/log'] },
      root,
      () => new Date(1000 + time++).toISOString(),
      () => ({ at: new Date(1000 + time++).toISOString(), values: { request_rate: 1 } }),
    );
    const baseline = await captures.baseline();
    assert.equal(baseline.incomplete, false);
    await writeFile(root + '/etc/config', 'after');
    await appendFile(root + '/etc/log', 'new\n');
    const request = { commandId: randomUUID(), commandSeq: 1 };
    const first = await captures.capture(request);
    assert.deepEqual(first.files, [{ path: '/etc/config', before: 'before', after: 'after' }]);
    assert.deepEqual(first.logs, [{ path: '/etc/log', lines: ['new'] }]);
    assert.deepEqual(await captures.capture(request), first);
    const next = await captures.capture({ commandId: randomUUID(), commandSeq: 2 });
    assert.equal(next.baselineAt, first.startedAt);
    assert.deepEqual(next.logs, []);

    // A rejected capture must not advance its file baseline before its receipt.
    let validMetric = false;
    const retryable = new FileCaptures(
      { configs: ['/etc/config'], logs: [] },
      root,
      () => new Date(2000 + time++).toISOString(),
      () => ({ at: new Date(2000 + time++).toISOString(), values: { request_rate: validMetric ? 1 : NaN } }),
    );
    await retryable.baseline();
    await writeFile(root + '/etc/config', 'after-rejected-capture');
    const retryRequest = { commandId: randomUUID(), commandSeq: 1 };
    await assert.rejects(retryable.capture(retryRequest), /monitor_failed/);
    validMetric = true;
    const retried = await retryable.capture(retryRequest);
    assert.equal(retried.sequence, 1);
    assert.deepEqual(retried.files, [{ path: '/etc/config', before: 'after', after: 'after-rejected-capture' }]);

    await symlink(secretRoot + '/secret', root + '/etc/link');
    assert.equal((await readWatchedFile(root, '/etc/link')).text, null);
    await symlink(secretRoot, root + '/parent');
    assert.equal((await readWatchedFile(root, '/parent/secret')).text, null);
    assert.equal((await readWatchedFile(root, '/missing')).incomplete, true);
    const expired = await readWatchedFile(root, '/etc/config', 0, performance.now() - 1);
    assert.equal(expired.text, null);
    assert.equal(expired.incomplete, true);
    await mkdir(root + '/etc/directory');
    assert.equal((await readWatchedFile(root, '/etc/directory')).text, null);
    execFileSync('mkfifo', [root + '/etc/fifo']);
    assert.equal((await readWatchedFile(root, '/etc/fifo')).text, null);
    await writeFile(root + '/etc/large', 'x'.repeat(20_000));
    const large = await readWatchedFile(root, '/etc/large');
    assert.equal(large.incomplete, true);
    assert.equal(large.text?.length, 16_384);
    await appendFile(root + '/etc/log', Array.from({ length: 201 }, () => 'line\n').join(''));
    const truncated = await captures.capture({ commandId: randomUUID(), commandSeq: 3 });
    assert.equal(truncated.incomplete, true);
    assert.equal(truncated.logs[0]?.lines.length, 200);
    await rename(root + '/etc/log', root + '/etc/old-log');
    await writeFile(root + '/etc/log', 'rotated\n');
    const rotated = await captures.capture({ commandId: randomUUID(), commandSeq: 4 });
    assert.equal(rotated.incomplete, true);
    assert.deepEqual(rotated.logs, [{ path: '/etc/log', lines: ['rotated'] }]);
    await writeFile(root + '/etc/log', 'x\n');
    const shortened = await captures.capture({ commandId: randomUUID(), commandSeq: 5 });
    assert.equal(shortened.incomplete, true);
    assert.deepEqual(shortened.logs, [{ path: '/etc/log', lines: ['x'] }]);

    // Replace an ancestor while reads are in progress. Each result must be a
    // held-directory observation or incomplete, never the linked Monitor path.
    await mkdir(root + '/racing');
    await writeFile(root + '/racing/secret', 'learner-visible');
    const replacements = (async () => {
      for (let i = 0; i < 100; i++) {
        await rename(root + '/racing', root + '/held');
        await symlink(secretRoot, root + '/racing');
        await rm(root + '/racing');
        await rename(root + '/held', root + '/racing');
      }
    })();
    const observations = [];
    for (let i = 0; i < 100; i++) observations.push(await readWatchedFile(root, '/racing/secret'));
    await replacements;
    assert.ok(observations.every((v) => v.text === null || v.text === 'learner-visible'));
    assert.ok(
      !JSON.stringify([first, next, truncated, rotated, shortened, observations]).includes('MONITOR_PRIVATE_SECRET'),
    );
    process.stdout.write('Linux capture safety passed.\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(secretRoot, { recursive: true, force: true });
  }
}
void main();
