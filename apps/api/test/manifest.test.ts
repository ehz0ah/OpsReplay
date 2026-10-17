import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { manifestHash, readManifest } from '../../../packages/session/src/manifest.js';
import { sessionRecord } from './session-fixture.js';
const manifest = JSON.parse(
  readFileSync(new URL('../../../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
);
test('private manifest read uses the admitted hash and is independent of object key order', async () => {
  const session = sessionRecord(randomUUID());
  session.pins.manifestSha256 = manifestHash(manifest);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  let key: unknown;
  const client = {
    send: async (command: GetCommand) => {
      key = command.input.Key;
      assert.equal(command.input.ConsistentRead, true);
      return { Item: { data: reordered } };
    },
  } as unknown as DynamoDBDocumentClient;
  assert.deepEqual(await readManifest(client, 'test-table', session), manifest);
  assert.deepEqual(key, {
    PK: 'CONTENT#challenge#wrong-upstream-port',
    SK: `MANIFEST#${manifest.version}#${session.pins.manifestSha256}`,
  });
  assert.equal(manifestHash(reordered), session.pins.manifestSha256);
});
test('missing, changed and mismatched private content fails closed', async () => {
  const session = sessionRecord(randomUUID());
  session.pins.manifestSha256 = manifestHash(manifest);
  for (const data of [
    undefined,
    { ...manifest, id: 'other' },
    { ...manifest, debrief: { ...manifest.debrief, rootCause: 'changed' } },
  ]) {
    const client = { send: async () => ({ Item: { data } }) } as unknown as DynamoDBDocumentClient;
    await assert.rejects(readManifest(client, 'test-table', session));
  }
});
