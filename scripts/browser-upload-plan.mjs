import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The generated Free lesson index is the allowlist; private prepared bodies are never read. */
export async function browserUploadPlan(directory) {
  const root = resolve(directory);
  for (const name of ['assets', 'learn']) {
    const stat = await lstat(join(root, name));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Browser upload directories cannot be symlinks.');
  }
  const file = async (key, cacheControl, maximumBytes) => {
    const path = join(root, key);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Browser upload requires regular files.');
    if (maximumBytes !== undefined && (stat.size === 0 || stat.size > maximumBytes))
      throw new Error('Browser font license notice is empty or too large.');
    return { path, key, cacheControl };
  };
  const assets = [];
  let hasFonts = false,
    hasFontLicenses = false;
  for (const name of (await readdir(join(root, 'assets'))).sort()) {
    const fontLicenses = /^font-licenses-[a-f0-9]{64}\.txt$/.test(name);
    if (!fontLicenses && !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2)$/.test(name))
      throw new Error('Unexpected browser asset name.');
    const asset = await file(
      'assets/' + name,
      'public,max-age=31536000,immutable',
      fontLicenses ? 32 * 1024 : undefined,
    );
    if (fontLicenses) {
      const checksum = createHash('sha256')
        .update(await readFile(asset.path))
        .digest('hex');
      if (name !== 'font-licenses-' + checksum + '.txt')
        throw new Error('Browser font license checksum does not match.');
    }
    assets.push(asset);
    hasFonts ||= name.endsWith('.woff2');
    hasFontLicenses ||= fontLicenses;
  }
  if (hasFonts && !hasFontLicenses) throw new Error('Browser font license notice is missing.');
  if (!assets.some(({ key }) => !key.endsWith('.txt'))) throw new Error('Browser assets are missing.');
  const indexFile = await file('learn/index.json', 'no-store');
  const indexText = await readFile(indexFile.path, 'utf8');
  if (Buffer.byteLength(indexText) > 256 * 1024) throw new Error('Lesson index exceeds its bound.');
  const index = JSON.parse(indexText);
  if (!Array.isArray(index) || index.length > 100) throw new Error('Invalid Free lesson index.');
  const lessons = [],
    ids = new Set();
  for (const entry of index) {
    if (!entry || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id) || entry.id.length > 100 || ids.has(entry.id))
      throw new Error('Invalid Free lesson identity.');
    ids.add(entry.id);
    const asset = await file('learn/' + entry.id + '.json', 'no-store');
    const body = await readFile(asset.path, 'utf8');
    if (Buffer.byteLength(body) > 256 * 1024) throw new Error('Lesson exceeds its bound.');
    const lesson = JSON.parse(body);
    if (lesson.plan !== 'free' || lesson.id !== entry.id || lesson.version !== entry.version)
      throw new Error('Free lesson body does not match its index.');
    lessons.push(asset);
  }
  // Publish the index only after all its referenced bodies, and HTML last.
  return [...assets, ...lessons, indexFile, await file('index.html', 'no-store')];
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length) throw new Error('Usage: browser-upload-plan.mjs dist/web');
  console.log(JSON.stringify(await browserUploadPlan(directory), null, 2));
}
