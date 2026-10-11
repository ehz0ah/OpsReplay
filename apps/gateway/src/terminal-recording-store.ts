import { randomUUID } from 'node:crypto';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
      await this.client.send(
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
    await this.requireLease(lease, now, signal);
    const items = [
      this.leaseCheck(lease, now),
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
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        ...items,
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
    try {
      await this.client.send(command, sendOptions(signal));
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
