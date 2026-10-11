import { createHash } from 'node:crypto';
import { canonicalJson } from '../../session/src/canonical.js';
import { commandEvidenceLimits as limits, isCommandEvidence, type CommandEvidence } from './command-evidence.js';

export interface CommandBatchReference {
  first: number;
  last: number;
  sha256: string;
}
export interface CommandPublication {
  schemaVersion: 1;
  first: number;
  last: number;
  batches: CommandBatchReference[];
}
export const commandBatchHash = (commands: readonly CommandEvidence[]) =>
  createHash('sha256').update(canonicalJson(commands)).digest('hex');
export function isCommandPublication(value: unknown): value is CommandPublication {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as CommandPublication;
  if (
    Object.keys(v).length !== 4 ||
    v.schemaVersion !== 1 ||
    !Number.isSafeInteger(v.first) ||
    v.first < 1 ||
    !Number.isSafeInteger(v.last) ||
    v.last < v.first ||
    v.last > limits.maximumCommands ||
    !Array.isArray(v.batches) ||
    !v.batches.length ||
    v.batches.length > limits.maximumCommands
  )
    return false;
  let after = v.first - 1;
  for (const batch of v.batches) {
    if (
      !batch ||
      Object.keys(batch).length !== 3 ||
      batch.first !== after + 1 ||
      !Number.isSafeInteger(batch.last) ||
      batch.last < batch.first ||
      batch.last - batch.first >= limits.maximumPageCommands ||
      !/^[a-f0-9]{64}$/.test(batch.sha256)
    )
      return false;
    after = batch.last;
  }
  return after === v.last;
}
export function isCommandBatch(value: unknown, reference: CommandBatchReference): value is CommandEvidence[] {
  return (
    Array.isArray(value) &&
    value.length === reference.last - reference.first + 1 &&
    value.every((command, index) => isCommandEvidence(command) && command.seq === reference.first + index) &&
    Buffer.byteLength(JSON.stringify(value)) <= limits.maximumPageBytes &&
    commandBatchHash(value) === reference.sha256
  );
}
