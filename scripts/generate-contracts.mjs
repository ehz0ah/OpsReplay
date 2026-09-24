import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';

const root = new URL('../packages/contracts/', import.meta.url);
const read = async (file) => JSON.parse(await readFile(new URL(file, root), 'utf8'));
const publicSchema = await read('schemas/public.schema.json');
const publicTypes = {
  ...publicSchema,
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(
    Object.keys(publicSchema.$defs).map((name) => [name, { $ref: `#/$defs/${name}` }]),
  ),
  required: Object.keys(publicSchema.$defs),
};
const options = {
  bannerComment: '/* Generated from JSON Schema by npm run contracts:generate. Do not edit. */',
  unknownAny: true,
  ignoreMinAndMaxItems: true,
  style: { singleQuote: true, printWidth: 100 },
};
await mkdir(new URL('src/generated/', root), { recursive: true });
for (const [file, schema, name] of [
  ['public.ts', publicTypes, 'PublicTypes'],
  ['scenario.ts', await read('schemas/scenario.schema.json'), 'Scenario'],
]) {
  const result = await compile({ ...schema, title: name }, name, options);
  const target = new URL(`src/generated/${file}`, root);
  if (process.argv.includes('--check')) {
    if (await readFile(target, 'utf8') !== result) {
      throw new Error(`${file} is stale. Run npm run contracts:generate.`);
    }
  } else {
    await writeFile(target, result);
  }
}
console.log('Contract types match JSON Schema.');
