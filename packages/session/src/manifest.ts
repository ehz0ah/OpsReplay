import { createHash } from 'node:crypto';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { canonicalJson } from './canonical.js';
import { isDebriefManifest, type DebriefManifest } from './debrief.js';
import type { SessionRecord } from '../../../apps/api/src/start-session/types.js';

export const manifestMaximumBytes = 256 * 1024;
export function manifestHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
/** Publication retains this immutable private item for every admitted content pin. */
export function manifestKey(id: string, version: string, sha256: string) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) ||
    id.length > 100 ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ||
    version.length > 60 ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error('Invalid manifest identity.');
  return { PK: `CONTENT#challenge#${id}`, SK: `MANIFEST#${version}#${sha256}` };
}
export async function readManifest(
  client: DynamoDBDocumentClient,
  table: string,
  session: SessionRecord,
  signal?: AbortSignal,
): Promise<DebriefManifest> {
  const result = await client.send(
    new GetCommand({
      TableName: table,
      Key: manifestKey(session.view.challenge.id, session.view.challenge.version, session.pins.manifestSha256),
      ConsistentRead: true,
    }),
    signal ? { abortSignal: signal } : undefined,
  );
  const data: unknown = result.Item?.data;
  if (
    !isDebriefManifest(data) ||
    Buffer.byteLength(canonicalJson(data)) > manifestMaximumBytes ||
    data.id !== session.view.challenge.id ||
    data.version !== session.view.challenge.version ||
    manifestHash(data) !== session.pins.manifestSha256
  )
    throw new Error('Pinned manifest is unavailable.');
  return structuredClone(data);
}
