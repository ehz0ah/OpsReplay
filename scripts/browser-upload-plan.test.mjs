import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserUploadPlan } from './browser-upload-plan.mjs';

async function sourceFontNotice() {
  const directory = new URL('../apps/web/public/assets/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^font-licenses-[a-f0-9]{64}\.txt$/.test(name));
  assert.equal(names.length, 1, 'The source build must have one current font license bundle.');
  return { name: names[0], body: await readFile(new URL(names[0], directory)) };
}
async function addFontNotice(root, contents) {
  const body = contents === undefined ? (await sourceFontNotice()).body : Buffer.from(contents);
  const hash = createHash('sha256').update(body).digest('hex');
  const name = 'font-licenses-' + hash + '.txt';
  const path = join(root, 'assets', name);
  await writeFile(path, body);
  return { name, path, hash, body };
}
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
test('WOFF2 fonts are immutable assets while unsafe names and symlinks block publication', async (t) => {
  await t.test('self-hosted font publishes with other assets before lesson data and HTML', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2'), 'wOF2');
    const notice = await addFontNotice(root);
    const plan = await browserUploadPlan(root);
    const font = plan.find((x) => x.key.endsWith('.woff2'));
    assert.ok(font);
    assert.equal(font.cacheControl, 'public,max-age=31536000,immutable');
    assert.ok(plan.indexOf(font) < plan.findIndex((x) => x.key === 'learn/index.json'));
    const license = plan.find((x) => x.key === 'assets/' + notice.name);
    assert.ok(license);
    assert.equal(license.cacheControl, 'public,max-age=31536000,immutable');
    assert.ok(plan.indexOf(license) < plan.findIndex((x) => x.key === 'learn/index.json'));
    assert.equal(plan.at(-1).key, 'index.html');
    assert.deepEqual(await browserUploadPlan(root), plan);
  });
  await t.test('unsupported or hidden asset types fail closed', async (t) => {
    for (const name of ['font.woff', 'font.woff2.js.map', '.font.woff2', 'font.WOFF2', 'private.json']) {
      const root = await fixture(t);
      await writeFile(join(root, 'assets', name), 'invalid');
      await assert.rejects(browserUploadPlan(root), /Unexpected browser asset name/);
    }
  });
  await t.test('a font extension cannot turn a symlink into a publishable file', async (t) => {
    const root = await fixture(t);
    const target = join(root, 'private.txt');
    await writeFile(target, 'private');
    await symlink(target, join(root, 'assets/font-abcd.woff2'));
    await assert.rejects(browserUploadPlan(root), /regular files/);
  });
});
test('font license notices preserve checked public asset publication', async (t) => {
  await t.test('the shipped notice contains both complete upstream licenses and its footer reference', async () => {
    const notice = await sourceFontNotice();
    const sans = await readFile(new URL('../node_modules/@fontsource/ibm-plex-sans/LICENSE', import.meta.url), 'utf8');
    const mono = await readFile(new URL('../node_modules/@fontsource/ibm-plex-mono/LICENSE', import.meta.url), 'utf8');
    const expected =
      'IBM Plex font licenses\n\nThese licenses apply to the bundled fonts, not to the OpsReplay application.\n' +
      'Source packages: @fontsource/ibm-plex-sans and @fontsource/ibm-plex-mono.\n\nIBM Plex Sans\n\n' +
      sans +
      '\nIBM Plex Mono\n\n' +
      mono;
    assert.equal(notice.body.toString('utf8'), expected);
    assert.equal(notice.name, 'font-licenses-' + createHash('sha256').update(notice.body).digest('hex') + '.txt');
    const app = await readFile(new URL('../apps/web/src/app.tsx', import.meta.url), 'utf8');
    assert.ok(app.includes('href="/assets/' + notice.name + '"'));
    assert.ok(app.includes('Font licenses (opens in a new tab)'));
  });
  await t.test('font assets require a license notice', async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, 'assets/font-abcd.woff2'), 'wOF2');
    await assert.rejects(browserUploadPlan(root), /font license notice is missing/);
  });
  await t.test('a notice alone cannot replace compiled assets', async (t) => {
    const root = await fixture(t);
    await rm(join(root, 'assets/app-abcd.js'));
    await addFontNotice(root);
    await assert.rejects(browserUploadPlan(root), /Browser assets are missing/);
  });
  await t.test('notice contents must match the filename checksum', async (t) => {
    const root = await fixture(t);
    const notice = await addFontNotice(root);
    await rm(notice.path);
    const wrongHash = (notice.hash[0] === '0' ? '1' : '0') + notice.hash.slice(1);
    await writeFile(join(root, 'assets/font-licenses-' + wrongHash + '.txt'), notice.body);
    await assert.rejects(browserUploadPlan(root), /font license checksum does not match/);
  });
  await t.test('notice file sizes use an inclusive byte limit', async (t) => {
    for (const [label, body, allowed] of [
      ['empty', Buffer.alloc(0), false],
      ['maximum', Buffer.alloc(32 * 1024, 'x'), true],
      ['over maximum', Buffer.alloc(32 * 1024 + 1, 'x'), false],
      ['multibyte over maximum', Buffer.from('界'.repeat(10923)), false],
    ]) {
      await t.test(label, async (t) => {
        const root = await fixture(t);
        await addFontNotice(root, body);
        if (allowed) assert.equal((await browserUploadPlan(root)).at(-1).key, 'index.html');
        else await assert.rejects(browserUploadPlan(root), /font license notice is empty or too large/);
      });
    }
  });
  await t.test('a matching notice name cannot publish a symlink', async (t) => {
    const root = await fixture(t);
    const notice = await addFontNotice(root);
    const target = join(root, 'private.txt');
    await writeFile(target, 'private fixture');
    await rm(notice.path);
    await symlink(target, notice.path);
    await assert.rejects(browserUploadPlan(root), /regular files/);
    assert.equal(await readFile(target, 'utf8'), 'private fixture');
  });
  await t.test('unfingerprinted, malformed and unrelated text assets remain rejected', async (t) => {
    for (const name of [
      'font-licenses.txt',
      'font-licenses-' + 'a'.repeat(63) + '.txt',
      'font-licenses-' + 'A'.repeat(64) + '.txt',
      'font-licenses-' + 'a'.repeat(64) + '.txt.map',
      '.font-licenses-' + 'a'.repeat(64) + '.txt',
      'private.txt',
    ]) {
      const root = await fixture(t);
      await writeFile(join(root, 'assets', name), 'not a published notice');
      await assert.rejects(browserUploadPlan(root), /Unexpected browser asset name/);
    }
  });
});
