import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../contracts/schemas/public.schema.json';
import type { PublicTypes } from '../../contracts/public-types.js';
import upstream from '../../../content/briefings/wrong-upstream-port/0.1.2.json';
import dns from '../../../content/briefings/stale-dns-record/0.1.2.json';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const valid = ajv.compile<PublicTypes['ChallengeBriefing']>({ $ref: schema.$id + '#/$defs/ChallengeBriefing' });
const entries = [upstream, dns];

/** Only reviewed public documentation is bundled; no private Challenge source is imported. */
export function publicBriefing(id: string, version: string): PublicTypes['ChallengeBriefing'] | null {
  const entry = entries.find((value) => value.id === id && value.version === version);
  if (!entry) return null;
  if (!valid(entry)) throw new Error('Public briefing is invalid.');
  return structuredClone(entry);
}
