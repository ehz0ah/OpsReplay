import { randomUUID } from 'node:crypto';
import { sendDynamoWrite } from '../../../packages/dynamodb/src/conflict-retry.js';
import {
  initialCommandParser,
  isCommandParserCheckpoint,
  type CommandParserCheckpoint,
} from '../../../packages/contracts/private/command-evidence.js';
import { parseCommandEvents } from './command-parser.js';
import { stageCommandEvidence } from './command-publication.js';
import type { TerminalPageArchive } from './terminal-page-archive.js';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  advanceTerminalCheckpoint,
  initialTerminalCheckpoint,
  encodeTerminalPage,
  isStoredTerminalPage,
  isTerminalRecordingCheckpoint,
  terminalMetadataContinues,
  type StoredTerminalPage,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  isTerminalRecordingReady,
  type TerminalRecordingPage,
  type TerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.js';
import { isMonitorControlTimestamp } from '../../../packages/contracts/private/monitor-control.js';
import { isMonitorRecordingIdentity } from './monitor-recording-identity.js';
import { DynamoMonitorRecordingStore, type MonitorRecorderLease } from './monitor-recording-store.js';

export interface TerminalRecordingStateStore {
  get(sessionId: string, signal?: AbortSignal): Promise<TerminalRecordingCheckpoint | undefined>;
  begin(
    lease: MonitorRecorderLease,
    ready: TerminalRecordingReady,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingCheckpoint>;
  commit(
    lease: MonitorRecorderLease,
    previous: TerminalRecordingCheckpoint,
    page: TerminalRecordingPage,
    reference: StoredTerminalPage | null,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingCheckpoint>;
}

export class TerminalRecordingStoreError extends Error {
  constructor(
    readonly code: 'invalid_config' | 'invalid_input' | 'invalid_store' | 'invalid_stream' | 'stale_lease' | 'conflict',
  ) {
    super('Terminal recording state operation failed.');
    this.name = 'TerminalRecordingStoreError';
  }
}
const key = (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: 'TERMINAL_RECORDING' });
const chunkKey = (sessionId: string, reference: StoredTerminalPage) => ({
  PK: `SESSION#${sessionId}`,
  SK: `TERMINAL_CHUNK#${reference.source}#${String(reference.nextSequence).padStart(6, '0')}`,
});
const sendOptions = (signal?: AbortSignal) => (signal === undefined ? undefined : { abortSignal: signal });
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}
function validLease(lease: MonitorRecorderLease, now: string): boolean {
  return (
    isMonitorRecordingIdentity(lease.sessionId, lease.generation) &&
    /^[A-Za-z0-9_-]{1,128}$/.test(lease.recorderId) &&
    isMonitorControlTimestamp(now)
  );
}

/** No new lease. A transaction checks RECORDING and writes only terminal state. */
export class DynamoTerminalRecordingStore implements TerminalRecordingStateStore {
  private readonly leases: DynamoMonitorRecordingStore;
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new TerminalRecordingStoreError('invalid_config');
    this.leases = new DynamoMonitorRecordingStore(client, table);
  }

  async get(sessionId: string, signal?: AbortSignal): Promise<TerminalRecordingCheckpoint | undefined> {
    if (!isMonitorRecordingIdentity(sessionId, 1)) throw new TerminalRecordingStoreError('invalid_input');
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: key(sessionId), ConsistentRead: true }),
      sendOptions(signal),
    );
    if (!result.Item) return undefined;
    if (!isTerminalRecordingCheckpoint(result.Item.data)) throw new TerminalRecordingStoreError('invalid_store');
    return structuredClone(result.Item.data);
  }

  private leaseCheck(lease: MonitorRecorderLease, now: string) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: { PK: `SESSION#${lease.sessionId}`, SK: 'RECORDING' },
        ConditionExpression:
          '(#data.#status = :recording OR (#data.#status = :draining AND #data.#deadline > :now)) AND #data.#owner = :owner AND #data.#generation = :generation AND #data.#expires > :now',
        ExpressionAttributeNames: {
          '#data': 'data',
          '#status': 'status',
          '#deadline': 'drainDeadlineAt',
          '#owner': 'recorderId',
          '#generation': 'generation',
          '#expires': 'leaseExpiresAt',
        },
        ExpressionAttributeValues: {
          ':recording': 'recording',
          ':draining': 'draining',
          ':owner': lease.recorderId,
          ':generation': lease.generation,
          ':now': now,
        },
      },
    };
  }

  private async requireLease(lease: MonitorRecorderLease, now: string, signal?: AbortSignal): Promise<void> {
    const state = await this.leases.get(lease.sessionId, signal);
    if (
      !state ||
      (state.status !== 'recording' && state.status !== 'draining') ||
      state.recorderId !== lease.recorderId ||
      state.generation !== lease.generation ||
      state.leaseExpiresAt! <= now ||
      (state.status === 'draining' && state.drainDeadlineAt! <= now)
    ) {
      throw new TerminalRecordingStoreError('stale_lease');
    }
  }

  async begin(
    lease: MonitorRecorderLease,
    ready: TerminalRecordingReady,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingCheckpoint> {
    if (!validLease(lease, now) || !isTerminalRecordingReady(ready))
      throw new TerminalRecordingStoreError('invalid_input');
    lease = { ...lease };
    const snapshot = structuredClone(ready);
    await this.requireLease(lease, now, signal);
    const current = await this.get(lease.sessionId, signal);
    if (current) {
      if (!terminalMetadataContinues(current.metadata, snapshot))
        throw new TerminalRecordingStoreError('invalid_stream');
      return current;
    }
    const initial = initialTerminalCheckpoint(snapshot);
    try {
      await sendDynamoWrite(
        this.client,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.leaseCheck(lease, now),
            {
              Put: {
                TableName: this.table,
                Item: { ...key(lease.sessionId), data: initial },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
        sendOptions(signal),
      );
      return initial;
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(lease.sessionId, signal);
      await this.requireLease(lease, now, signal);
      if (saved) {
        if (!terminalMetadataContinues(saved.metadata, snapshot))
          throw new TerminalRecordingStoreError('invalid_stream');
        return saved;
      }
      throw error;
    }
  }

  private async parser(sessionId: string, signal?: AbortSignal): Promise<CommandParserCheckpoint | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: `SESSION#${sessionId}`, SK: 'COMMAND_PARSER' },
        ConsistentRead: true,
      }),
      sendOptions(signal),
    );
    if (!result.Item) return undefined;
    if (!isCommandParserCheckpoint(result.Item.data)) throw new TerminalRecordingStoreError('invalid_store');
    return structuredClone(result.Item.data);
  }

  /** Find the boundary page using metadata, then parse only that page from its
   * previous published checkpoint. Do not re-read thousands of S3 pages in drain. */
  async cutoffParser(
    sessionId: string,
    checkpoint: TerminalRecordingCheckpoint,
    cutoffAt: string,
    pages: Pick<TerminalPageArchive, 'readLive'>,
    signal: AbortSignal,
  ): Promise<CommandParserCheckpoint> {
    if (
      !isMonitorRecordingIdentity(sessionId, 1) ||
      !isTerminalRecordingCheckpoint(checkpoint) ||
      !isMonitorControlTimestamp(cutoffAt)
    )
      throw new TerminalRecordingStoreError('invalid_input');
    checkpoint = structuredClone(checkpoint);
    const live = await this.parser(sessionId, signal);
    if (!live || live.cursor !== checkpoint.cursor || live.source !== checkpoint.metadata.source)
      throw new TerminalRecordingStoreError('invalid_store');
    if (!checkpoint.frontier || checkpoint.frontier.recordedAt <= cutoffAt) return live;
    let cursor: Record<string, unknown> | undefined;
    let inspected = 0;
    const prefix = `TERMINAL_CHUNK#${checkpoint.metadata.source}#`;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          ConsistentRead: true,
          ScanIndexForward: false,
          Limit: 100,
          KeyConditionExpression: 'PK = :pk AND SK BETWEEN :low AND :high',
          ExpressionAttributeValues: {
            ':pk': `SESSION#${sessionId}`,
            ':low': `${prefix}000001`,
            ':high': `${prefix}${String(checkpoint.cursor).padStart(6, '0')}`,
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
        { abortSignal: signal },
      );
      inspected += result.Items?.length ?? 0;
      if (
        inspected > 100000 ||
        (result.LastEvaluatedKey &&
          (result.LastEvaluatedKey.PK !== `SESSION#${sessionId}` ||
            typeof result.LastEvaluatedKey.SK !== 'string' ||
            !result.LastEvaluatedKey.SK.startsWith(prefix) ||
            (cursor && result.LastEvaluatedKey.SK >= (cursor.SK as string))))
      )
        throw new TerminalRecordingStoreError('invalid_store');
      for (const row of result.Items ?? []) {
        const reference = row.data as StoredTerminalPage;
        if (!reference || typeof reference.objectKey !== 'string')
          throw new TerminalRecordingStoreError('invalid_store');
        if (!isStoredTerminalPage(reference, sessionId, Number(reference.objectKey.split('/')[3])))
          throw new TerminalRecordingStoreError('invalid_store');
        if (reference.firstAt > cutoffAt && reference.after !== 0) continue;
        const saved =
          reference.after === 0
            ? initialCommandParser(checkpoint.metadata.source)
            : (
                await this.client.send(
                  new GetCommand({
                    TableName: this.table,
                    Key: {
                      PK: `SESSION#${sessionId}`,
                      SK: `COMMAND_CHECKPOINT#${String(reference.after).padStart(6, '0')}`,
                    },
                    ConsistentRead: true,
                  }),
                  { abortSignal: signal },
                )
              ).Item?.data;
        if (
          !isCommandParserCheckpoint(saved) ||
          saved.cursor !== reference.after ||
          saved.source !== checkpoint.metadata.source
        )
          throw new TerminalRecordingStoreError('invalid_store');
        const page = await pages.readLive(sessionId, reference, signal);
        return parseCommandEvents(
          saved,
          page.events.filter((event) => event.recordedAt <= cutoffAt),
        ).checkpoint;
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    throw new TerminalRecordingStoreError('invalid_store');
  }

  async commit(
    lease: MonitorRecorderLease,
    previous: TerminalRecordingCheckpoint,
    page: TerminalRecordingPage,
    reference: StoredTerminalPage | null,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingCheckpoint> {
    if (!validLease(lease, now) || !isTerminalRecordingCheckpoint(previous))
      throw new TerminalRecordingStoreError('invalid_input');
    lease = { ...lease };
    let next: TerminalRecordingCheckpoint;
    try {
      next = advanceTerminalCheckpoint(previous, page);
    } catch {
      throw new TerminalRecordingStoreError('invalid_stream');
    }
    if (
      page.events.length === 0
        ? reference !== null
        : !isStoredTerminalPage(reference, lease.sessionId, lease.generation) ||
          canonical(reference) !==
            canonical(encodeTerminalPage(lease.sessionId, lease.generation, previous.cursor, page).reference)
    ) {
      throw new TerminalRecordingStoreError('invalid_input');
    }
    const savedReference = reference === null ? null : structuredClone(reference);
    const snapshot = structuredClone(previous);
    const savedParser = await this.parser(lease.sessionId, signal);
    // A retry can arrive after its atomic page/parser commit. Recover only the
    // exact immutable page receipt, never skip a new page with an advanced parser.
    if (savedParser && savedParser.cursor !== previous.cursor) {
      if (savedReference) {
        const receipt = await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: chunkKey(lease.sessionId, savedReference),
            ConsistentRead: true,
          }),
          sendOptions(signal),
        );
        if (canonical(receipt.Item?.data) === canonical(savedReference)) return next;
      }
      throw new TerminalRecordingStoreError('conflict');
    }
    const parser = savedParser ?? {
      ...initialCommandParser(previous.metadata.source),
      cursor: previous.cursor,
      lossAt: previous.cursor === 0 ? null : previous.metadata.startedAt,
    };
    if (parser.source !== previous.metadata.source) throw new TerminalRecordingStoreError('invalid_store');
    const derived = parseCommandEvents(parser, page.events);
    const items = [
      this.leaseCheck(lease, now),
      {
        ConditionCheck: {
          TableName: this.table,
          Key: { PK: `SESSION#${lease.sessionId}`, SK: 'RECORDING_COVERAGE' },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      {
        Put: {
          TableName: this.table,
          Item: { ...key(lease.sessionId), data: next },
          ConditionExpression: '#data = :previous',
          ExpressionAttributeNames: { '#data': 'data' },
          ExpressionAttributeValues: { ':previous': snapshot },
        },
      },
    ];
    try {
      const publication = await stageCommandEvidence(
        this.client,
        this.table,
        lease.sessionId,
        'COMMAND',
        derived.commands,
        [
          this.leaseCheck(lease, now),
          {
            ConditionCheck: {
              TableName: this.table,
              Key: { PK: `SESSION#${lease.sessionId}`, SK: 'RECORDING_COVERAGE' },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            ConditionCheck: {
              TableName: this.table,
              Key: key(lease.sessionId),
              ConditionExpression: '#data = :previous',
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':previous': snapshot },
            },
          },
        ],
        signal,
      );
      const command = new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          ...items,
          {
            Put: {
              TableName: this.table,
              Item: { PK: `SESSION#${lease.sessionId}`, SK: 'COMMAND_PARSER', data: derived.checkpoint },
              ConditionExpression: savedParser ? '#data = :previous' : 'attribute_not_exists(PK)',
              ...(savedParser
                ? {
                    ExpressionAttributeNames: { '#data': 'data' },
                    ExpressionAttributeValues: { ':previous': savedParser },
                  }
                : {}),
            },
          },
          ...(publication
            ? [
                {
                  Put: {
                    TableName: this.table,
                    Item: {
                      PK: `SESSION#${lease.sessionId}`,
                      SK: `COMMAND#${String(publication.first).padStart(6, '0')}`,
                      data: publication,
                    },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
              ]
            : derived.commands.map((data) => ({
                Put: {
                  TableName: this.table,
                  Item: { PK: `SESSION#${lease.sessionId}`, SK: `COMMAND#${String(data.seq).padStart(6, '0')}`, data },
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              }))),
          ...(savedReference
            ? [
                {
                  Put: {
                    TableName: this.table,
                    Item: {
                      PK: `SESSION#${lease.sessionId}`,
                      SK: `COMMAND_CHECKPOINT#${String(next.cursor).padStart(6, '0')}`,
                      data: derived.checkpoint,
                    },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
              ]
            : []),
          ...(savedReference === null
            ? []
            : [
                {
                  Put: {
                    TableName: this.table,
                    Item: { ...chunkKey(lease.sessionId, savedReference), data: savedReference },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
              ]),
        ],
      });
      await sendDynamoWrite(this.client, command, sendOptions(signal));
      return structuredClone(next);
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(lease.sessionId, signal);
      if (savedReference !== null) {
        const chunk = await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: chunkKey(lease.sessionId, savedReference),
            ConsistentRead: true,
          }),
          sendOptions(signal),
        );
        if (
          saved &&
          saved.cursor >= next.cursor &&
          saved.metadata.source === next.metadata.source &&
          canonical(chunk.Item?.data) === canonical(savedReference)
        )
          return next;
      } else if (saved && canonical(saved) === canonical(next)) return next;
      await this.requireLease(lease, now, signal);
      if (
        error instanceof Error &&
        ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name)
      ) {
        throw new TerminalRecordingStoreError('conflict');
      }
      throw error;
    }
  }
}
