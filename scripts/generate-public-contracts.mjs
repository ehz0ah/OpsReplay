import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import standalone from 'ajv/dist/standalone/index.js';
import { build } from 'esbuild';
import { format } from 'prettier';
const root = new URL('../', import.meta.url);
const schema = JSON.parse(await readFile(new URL('packages/contracts/schemas/public.schema.json', root), 'utf8'));
const types = await format(
  await compile(
    {
      ...schema,
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(Object.keys(schema.$defs).map((name) => [name, { $ref: `#/$defs/${name}` }])),
      required: Object.keys(schema.$defs),
      title: 'PublicTypes',
    },
    'PublicTypes',
    {
      unknownAny: true,
      ignoreMinAndMaxItems: true,
      bannerComment: '/* Generated from public.schema.json. Run npm run contracts:generate. */',
    },
  ),
  { ...JSON.parse(await readFile(new URL('.prettierrc.json', root), 'utf8')), parser: 'typescript' },
);
const target = new URL('packages/contracts/public-types.ts', root);
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')) !== types)
    throw new Error('Public types are stale. Run npm run contracts:generate.');
} else await writeFile(target, types);
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, code: { source: true, esm: true } });
addFormats(ajv);
ajv.addSchema(schema);
const groups = {
  requests: ['StartSessionRequest', 'MutationRequest'],
  entry: ['Error', 'Catalog', 'Account'],
  session: [
    'SessionView',
    'SessionResponse',
    'EndSessionResponse',
    'TerminalTicket',
    'HintResponse',
    'TimelinePage',
    'GatewayClientMessage',
    'GatewayServerMessage',
  ],
  results: ['Debrief', 'Playback'],
};
const directory = new URL('.local/contracts/', root);
await mkdir(directory, { recursive: true });
for (const [group, names] of Object.entries(groups)) {
  const exports = Object.fromEntries(names.map((name) => [name, `${schema.$id}#/$defs/${name}`]));
  for (const ref of Object.values(exports)) ajv.getSchema(ref);
  const output = await build({
    stdin: { contents: standalone(ajv, exports), resolveDir: fileURLToPath(root) },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
  });
  await writeFile(new URL(`${group}-validators.js`, directory), output.outputFiles[0].contents);
  await writeFile(
    new URL(`${group}-validators.d.ts`, directory),
    `import type { PublicTypes } from '../../packages/contracts/public-types.js';\n` +
      names.map((name) => `export function ${name}(value: unknown): value is PublicTypes['${name}'];`).join('\n') +
      '\n',
  );
}
console.log('Public types checked; browser validators compiled without runtime evaluation.');
