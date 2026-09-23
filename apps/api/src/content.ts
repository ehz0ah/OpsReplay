import type { Catalog, CatalogEntry } from '@opsreplay/contracts';
import { compileScenario } from '@opsreplay/engine';
import type { CompiledScenario } from '@opsreplay/engine';
import { ApiError } from './errors.js';

export class ContentRepository {
  readonly scenarios: CompiledScenario[];

  constructor(
    definitions: unknown[],
    readonly allowDrafts: boolean,
  ) {
    this.scenarios = definitions.map(compileScenario);
    const keys = this.scenarios.map(({ definition: d }) => `${d.id}@${d.version}`);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate content version');
  }

  get(id: string, version: string): CompiledScenario {
    const result = this.scenarios.find(
      ({ definition }) =>
        definition.id === id &&
        definition.version === version &&
        (definition.status === 'published' || this.allowDrafts),
    );
    if (!result) throw new ApiError('NOT_FOUND', 'Challenge version not found.');
    return result;
  }

  catalog(filters: Record<string, string>): Catalog {
    const all: CatalogEntry[] = this.scenarios
      .filter(({ definition }) => definition.status === 'published' || this.allowDrafts)
      .map(({ definition: d }) => ({
        id: d.id,
        version: d.version,
        title: d.title,
        mode: 'challenge',
        access: 'practice',
        difficulty: d.difficulty,
        domain: d.domain,
      }));
    return {
      items: all.filter((entry) =>
        Object.entries(filters).every(([key, value]) => entry[key as keyof CatalogEntry] === value),
      ),
      nextCursor: null,
      availableLanguages: [],
      availableFilters: {
        modes: [...new Set(all.map((entry) => entry.mode))],
        difficulties: [
          ...new Set(all.flatMap((entry) => (entry.difficulty ? [entry.difficulty] : []))),
        ],
        domains: [...new Set(all.map((entry) => entry.domain))],
      },
    };
  }
}
