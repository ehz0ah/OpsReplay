import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { isCommandEvidence, type CommandEvidence } from '../../contracts/private/command-evidence.js';
import { isCommandPublication, isCommandBatch } from '../../contracts/private/command-publication.js';

export class CommandEvidenceReadError extends Error {
  constructor() {
    super('Command evidence is invalid.');
    this.name = 'CommandEvidenceReadError';
  }
}

/** Only exact batch references published with a terminal checkpoint are readable. */
export async function expandCommandRow(
  client: DynamoDBDocumentClient,
  table: string,
  sessionId: string,
  prefix: 'COMMAND' | 'SEALED_COMMAND',
  row: Record<string, unknown>,
  signal?: AbortSignal,
  after = 0,
  through = 5000,
): Promise<CommandEvidence[]> {
  if (isCommandEvidence(row.data)) {
    if (row.SK !== `${prefix}#${String(row.data.seq).padStart(6, '0')}`) throw new CommandEvidenceReadError();
    return row.data.seq > after && row.data.seq <= through ? [row.data] : [];
  }
  if (!isCommandPublication(row.data) || row.SK !== `${prefix}#${String(row.data.first).padStart(6, '0')}`)
    throw new CommandEvidenceReadError();
  const commands: CommandEvidence[] = [];
  for (const batch of row.data.batches) {
    if (batch.last <= after || batch.first > through) continue;
    const saved = await client.send(
      new GetCommand({
        TableName: table,
        Key: { PK: `SESSION#${sessionId}`, SK: `${prefix}_BATCH#${batch.sha256}` },
        ConsistentRead: true,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!isCommandBatch(saved.Item?.data, batch)) throw new CommandEvidenceReadError();
    commands.push(...saved.Item.data.filter((command) => command.seq > after && command.seq <= through));
  }
  return commands;
}

/** Seek the publication that may span the cursor, then read at most 20 commands. */
export async function readCommandPage(
  client: DynamoDBDocumentClient,
  table: string,
  sessionId: string,
  prefix: 'COMMAND' | 'SEALED_COMMAND',
  after: number,
  target: number,
  signal: AbortSignal,
): Promise<CommandEvidence[]> {
  if (after >= target) return [];
  const pk = `SESSION#${sessionId}`;
  const sk = (seq: number) => `${prefix}#${String(seq).padStart(6, '0')}`;
  const prior = await client.send(
    new QueryCommand({
      TableName: table,
      ConsistentRead: true,
      ScanIndexForward: false,
      Limit: 1,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :low AND :high',
      ExpressionAttributeValues: { ':pk': pk, ':low': sk(1), ':high': sk(after + 1) },
    }),
    { abortSignal: signal },
  );
  const row = prior.Items?.[0];
  const first = row && isCommandPublication(row.data) && row.data.last > after ? row.data.first : after + 1;
  const result = await client.send(
    new QueryCommand({
      TableName: table,
      ConsistentRead: true,
      Limit: 20,
      KeyConditionExpression: 'PK = :pk AND SK BETWEEN :low AND :high',
      ExpressionAttributeValues: { ':pk': pk, ':low': sk(first), ':high': sk(target) },
    }),
    { abortSignal: signal },
  );
  const commands: CommandEvidence[] = [];
  for (const saved of result.Items ?? []) {
    commands.push(
      ...(await expandCommandRow(client, table, sessionId, prefix, saved, signal, after, Math.min(target, after + 20))),
    );
    if (commands.length >= 20) break;
  }
  return commands;
}
