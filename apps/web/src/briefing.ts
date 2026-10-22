import { parsePublic } from '../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';

// This directory contains reviewed public briefings only. Never glob Challenge manifests.
const sources = import.meta.glob('../../../content/briefings/*/*.json', { import: 'default' });

export async function readBriefing(id: string, version: string): Promise<PublicTypes['ChallengeBriefing'] | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    throw new Error('Invalid briefing identity.');
  const load = sources[`../../../content/briefings/${id}/${version}.json`];
  if (!load) return null;
  const value = await parsePublic('ChallengeBriefing', await load());
  if (value.id !== id || value.version !== version) throw new Error('The briefing does not match this Challenge.');
  return value;
}
