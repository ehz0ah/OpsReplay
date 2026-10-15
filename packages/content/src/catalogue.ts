import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../contracts/schemas/public.schema.json';

export interface CatalogEntry {
  id: string;
  version: string;
  mode: 'learn' | 'challenge' | 'code_review';
  title: string;
  summary: string;
  category: string;
  plan: 'free' | 'pro';
  tier?: 'easy' | 'medium' | 'hard';
  language?: string;
}

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
export const validCatalogEntry = ajv.compile<CatalogEntry>({
  $ref: `${publicSchema.$id}#/$defs/CatalogEntry`,
});
export const cataloguePartition = 'CATALOG#PUBLIC';
export function catalogueKey(entry: Pick<CatalogEntry, 'mode' | 'id' | 'version'>) {
  return { PK: cataloguePartition, SK: `ENTRY#${entry.mode}#${entry.id}#${entry.version}` };
}
