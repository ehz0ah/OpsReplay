import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { parseLesson, prepareLesson } from '../packages/content/src/learn.ts';
const root = new URL('../', import.meta.url);
const related = new Set();
for (const [directory, mode, file] of [
  ['challenges', 'challenge', 'challenge.json'],
  ['reviews', 'code_review', 'review.json'],
])
  for (const item of await readdir(new URL(`content/${directory}/`, root), { withFileTypes: true }))
    if (item.isDirectory()) {
      const content = JSON.parse(await readFile(new URL(`content/${directory}/${item.name}/${file}`, root), 'utf8'));
      related.add(`${mode}#${content.id}`);
    }
const output = new URL('.local/learn/', root);
const publicOutput = new URL('apps/web/public/learn/', root);
await rm(publicOutput, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(publicOutput, { recursive: true });
const free = [];
const ids = new Set();
for (const file of (await readdir(new URL('content/learn/', root))).sort()) {
  if (!file.endsWith('.md') || file === 'README.md') continue;
  const entry = parseLesson(await readFile(new URL(`content/learn/${file}`, root), 'utf8'), related);
  if (ids.has(entry.id)) throw new Error('Duplicate lesson ID.');
  ids.add(entry.id);
  const prepared = prepareLesson(entry);
  await writeFile(new URL(`${entry.id}.json`, output), JSON.stringify(prepared));
  if (entry.plan === 'free') {
    free.push({
      id: entry.id,
      version: entry.version,
      title: entry.title,
      category: entry.category,
      summary: entry.summary,
    });
    await writeFile(new URL(`${entry.id}.json`, publicOutput), prepared.body);
  }
}
await writeFile(new URL('index.json', publicOutput), JSON.stringify(free));
console.log(`Built ${ids.size} lessons; ${free.length} free static entries. Pro bodies remain private.`);
