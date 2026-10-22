import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserUploadPlan } from './browser-upload-plan.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opsreplay-browser-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'));
  await mkdir(join(root, 'learn'));
  await writeFile(join(root, 'assets/app-abcd.js'), 'export {};');
  await writeFile(join(root, 'index.html'), '<main></main>');
  await writeFile(join(root, 'learn/index.json'), JSON.stringify([{ id: 'safe-recovery', version: '0.1.0' }]));
  await writeFile(
    join(root, 'learn/safe-recovery.json'),
    JSON.stringify({ id: 'safe-recovery', version: '0.1.0', plan: 'free' }),
  );
  return root;
}
test('upload includes every referenced free lesson before index and HTML, excluding private and config files', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'learn/pro-body.json'), '{"plan":"pro"}');
  await writeFile(join(root, 'config.example.json'), '{}');
  await writeFile(join(root, 'assets/0.1.2-abcd.js'), 'export {};');
  const plan = await browserUploadPlan(root);
  assert.deepEqual(
    plan.map((x) => x.key),
    ['assets/0.1.2-abcd.js', 'assets/app-abcd.js', 'learn/safe-recovery.json', 'learn/index.json', 'index.html'],
  );
  assert.equal(plan[0].cacheControl, 'public,max-age=31536000,immutable');
  assert.ok(plan.slice(2).every((x) => x.cacheControl === 'no-store'));
});
test('missing, mismatched or Pro lesson bodies block the whole upload plan', async (t) => {
  for (const fault of ['missing', 'pro', 'version']) {
    const root = await fixture(t),
      path = join(root, 'learn/safe-recovery.json');
    if (fault === 'missing') await rm(path);
    else
      await writeFile(
        path,
        JSON.stringify({
          id: 'safe-recovery',
          version: fault === 'version' ? '0.2.0' : '0.1.0',
          plan: fault === 'pro' ? 'pro' : 'free',
        }),
      );
    await assert.rejects(browserUploadPlan(root));
  }
});
test('lesson index cannot select paths outside the public lesson directory', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'learn/index.json'), JSON.stringify([{ id: '../private', version: '0.1.0' }]));
  await assert.rejects(browserUploadPlan(root), /identity/);
});
