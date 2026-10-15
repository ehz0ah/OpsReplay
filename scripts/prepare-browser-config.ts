import { readFile, writeFile } from 'node:fs/promises';
import { parseConfig } from '../apps/web/src/config.js';
export async function prepareConfig(input: string, origin: string, output: string) {
  const text = await readFile(input, 'utf8');
  if (text.length > 8192) throw new Error('Public configuration is too large.');
  const config = parseConfig(JSON.parse(text), origin);
  await writeFile(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  return config;
}
if (process.argv[1]?.endsWith('prepare-browser-config.ts')) {
  const [input, origin, output, ...extra] = process.argv.slice(2);
  if (!input || !origin || !output || extra.length)
    throw new Error('Usage: prepare-browser-config.ts input.json https://browser-host output.json');
  await prepareConfig(input, origin, output);
}
