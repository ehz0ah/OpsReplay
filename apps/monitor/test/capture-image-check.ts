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
    assert.equal(large.unavailable, false);
    // The byte cap may split a multi-byte character, but never invalid interior bytes.
    await writeFile(root + '/etc/utf8', 'x'.repeat(16_383) + '😀tail');
    const utf8 = await readWatchedFile(root, '/etc/utf8');
    assert.equal(utf8.text, 'x'.repeat(16_383));
    assert.equal(utf8.incomplete, true);
    assert.equal(utf8.unavailable, false);
    await writeFile(root + '/etc/invalid', Buffer.from([0x61, 0xff, 0x62]));
    assert.equal((await readWatchedFile(root, '/etc/invalid')).unavailable, true);
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

    assert.equal(truncated.unavailable, false);
    assert.equal(rotated.unavailable, false);
    assert.equal(shortened.unavailable, false);
    await appendFile(root + '/etc/log', ('large ' + 'x'.repeat(100) + '\n').repeat(300));
    const burst = await captures.capture({ commandId: randomUUID(), commandSeq: 6 });
    assert.equal(burst.incomplete, true);
    assert.equal(burst.unavailable, false);
    await appendFile(root + '/etc/log', 'next interval\n');
    const fresh = await captures.capture({ commandId: randomUUID(), commandSeq: 7 });
    assert.deepEqual(fresh.logs, [{ path: '/etc/log', lines: ['next interval'] }]);
    assert.equal(fresh.incomplete, false);
    await rm(root + '/etc/log');
    const missing = await captures.capture({ commandId: randomUUID(), commandSeq: 8 });
    assert.equal(missing.incomplete, true);
    assert.equal(missing.unavailable, true);
    for (const path of ['/etc/link', '/parent/secret', '/missing', '/etc/directory', '/etc/fifo'])
      assert.equal((await readWatchedFile(root, path)).unavailable, true);
    assert.equal(expired.unavailable, true);
    const unsafeBaseline = new FileCaptures({ configs: ['/etc/link'], logs: [] }, root);
    assert.equal((await unsafeBaseline.baseline()).unavailable, true);
    const absentMetric = new FileCaptures({ configs: [], logs: [] }, root);
    await absentMetric.baseline();
    assert.equal((await absentMetric.capture({ commandId: randomUUID(), commandSeq: 1 })).unavailable, true);
    // Per-file and aggregate excerpt bounds are warnings even for a large baseline.
    const paths = Array.from({ length: 20 }, (_, index) => `/etc/config-${index}`);
    for (const path of paths) await writeFile(root + path, 'a'.repeat(20_000));
    const aggregate = new FileCaptures(
      { configs: paths, logs: [] },
      root,
      () => new Date(3000 + time++).toISOString(),
      () => ({ at: new Date(3000 + time++).toISOString(), values: { request_rate: 1 } }),
    );
    assert.deepEqual((await aggregate.baseline()).unavailable, false);
    for (const path of paths) await writeFile(root + path, 'b'.repeat(20_000));
    const bounded = await aggregate.capture({ commandId: randomUUID(), commandSeq: 1 });
    assert.equal(bounded.incomplete, true);
    assert.equal(bounded.unavailable, false);
    assert.ok(bounded.files.length < paths.length);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 256 * 1024);

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
