import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../contracts/schemas/public.schema.json';
import type { PublicTypes } from '../../contracts/public-types.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const valid = ajv.getSchema(schema.$id + '#/$defs/ChallengeBriefing')!;

test('authored briefings match the exact Challenge version and service file locations', () => {
  const root = new URL('../../../content/briefings/', import.meta.url);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = entry.name;
    const files = readdirSync(new URL(directory + '/', root));
    for (const file of files) {
      const briefing: PublicTypes['ChallengeBriefing'] = JSON.parse(
        readFileSync(new URL(directory + '/' + file, root), 'utf8'),
      );
      assert.ok(valid(briefing), JSON.stringify(valid.errors));
      assert.equal(briefing.id, directory);
      assert.equal(file, briefing.version + '.json');
      const manifest = JSON.parse(
        readFileSync(new URL('../../../content/challenges/' + directory + '/challenge.json', import.meta.url), 'utf8'),
      );
      // Older briefings remain versioned and available to existing attempts.
      if (briefing.version !== manifest.version) continue;
      assert.deepEqual(
        briefing.services.map(({ name, configFiles, logFiles }) => ({ name, configFiles, logFiles })),
        manifest.environment.services.map(
          ({ name, configFiles, logFiles }: PublicTypes['ChallengeBriefing']['services'][number]) => ({
            name,
            configFiles,
            logFiles,
          }),
        ),
      );
      assert.equal(new Set(briefing.services.map((service) => service.name)).size, briefing.services.length);
    }
  }
});

test('briefing contract rejects private fields and unsafe file paths at every level', () => {
  const value = JSON.parse(
    readFileSync(new URL('../../contracts/examples/challenge-briefing.json', import.meta.url), 'utf8'),
  );
  assert.ok(valid(value));
  for (const field of ['rootCause', 'referenceFix', 'traps', 'hints', 'healthProbes', 'taskAddress'])
    assert.equal(valid({ ...value, [field]: 'private' }), false, field);
  for (const field of ['listens', 'contents', 'solution', 'image'])
    assert.equal(valid({ ...value, services: [{ ...value.services[0], [field]: 'private' }] }), false, field);
  for (const path of ['/etc/../secret', '/etc//nginx.conf', 'https://example.com', '/etc/config\nsecret'])
    assert.equal(valid({ ...value, services: [{ ...value.services[0], configFiles: [path] }] }), false, path);
});
