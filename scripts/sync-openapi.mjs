import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicSchema = JSON.parse(fs.readFileSync(path.join(root, 'packages/contracts/schemas/public.schema.json')));
const apiPath = path.join(root, 'packages/contracts/openapi.json');
const api = JSON.parse(fs.readFileSync(apiPath));

function rewrite(value) {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === '$ref' ? item.replace('#/$defs/', '#/components/schemas/') : rewrite(item),
      ]),
    );
  }
  return value;
}

api.components.schemas = rewrite(publicSchema.$defs);
fs.writeFileSync(apiPath, JSON.stringify(api, null, 2) + '\n');
console.log('Updated OpenAPI component schemas from public.schema.json.');
