import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { commandEvidenceLimits, type CommandEvidence } from '../../../packages/contracts/private/command-evidence.js';
import { commandBatchHash, type CommandPublication } from '../../../packages/contracts/private/command-publication.js';
import { sendDynamoWrite } from '../../../packages/dynamodb/src/conflict-retry.js';
import { canonicalJson } from '../../../packages/session/src/canonical.js';

/** Small pages stay atomic. Large pages stage content-addressed batches and the
 * terminal transaction publishes exact hashes. Competing unpublished pages cannot
 * reserve a command sequence or make staged evidence visible. */
export async function stageCommandEvidence(
  client: DynamoDBDocumentClient,
  table: string,
  sessionId: string,
  prefix: 'COMMAND' | 'SEALED_COMMAND',
  commands: readonly CommandEvidence[],
  checks: NonNullable<TransactWriteCommandInput['TransactItems']>,
  signal?: AbortSignal,
): Promise<CommandPublication | undefined> {
  if (
    commands.length <= commandEvidenceLimits.maximumPageCommands &&
    Buffer.byteLength(JSON.stringify(commands)) <= commandEvidenceLimits.maximumPageBytes
  )
    return undefined;
  const publication: CommandPublication = {
    schemaVersion: 1,
    first: commands[0]!.seq,
    last: commands.at(-1)!.seq,
    batches: [],
  };
  let offset = 0;
  while (offset < commands.length) {
    signal?.throwIfAborted();
    const batch: CommandEvidence[] = [];
    let bytes = 2;
    while (offset < commands.length && batch.length < commandEvidenceLimits.maximumPageCommands) {
      const value = commands[offset]!;
      const length = Buffer.byteLength(JSON.stringify(value)) + (batch.length ? 1 : 0);
      if (batch.length && bytes + length > commandEvidenceLimits.maximumPageBytes) break;
      batch.push(value);
      bytes += length;
      offset++;
    }
    const reference = { first: batch[0]!.seq, last: batch.at(-1)!.seq, sha256: commandBatchHash(batch) };
    const Key = { PK: `SESSION#${sessionId}`, SK: `${prefix}_BATCH#${reference.sha256}` };
    try {
      await sendDynamoWrite(
        client,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            ...checks,
            {
              Put: { TableName: table, Item: { ...Key, data: batch }, ConditionExpression: 'attribute_not_exists(PK)' },
            },
          ],
        }),
        signal ? { abortSignal: signal } : undefined,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await client.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (canonicalJson(saved.Item?.data) !== canonicalJson(batch)) throw error;
    }
    publication.batches.push(reference);
  }
  return publication;
}
