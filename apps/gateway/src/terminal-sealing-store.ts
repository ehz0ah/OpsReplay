import { randomUUID } from 'node:crypto';
import { sendDynamoWrite } from '../../../packages/dynamodb/src/conflict-retry.js';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  encodeTerminalPage,
  isStoredTerminalPage,
  type StoredTerminalPage,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  isSealedTerminalPage,
  isTerminalSealState,
  encodeSealedTerminalPage,
  type SealedTerminalPage,
  type TerminalSealState,
} from '../../../packages/contracts/private/terminal-sealing.js';
import { isMonitorControlTimestamp } from '../../../packages/contracts/private/monitor-control.js';
import type { TerminalRecordingPage } from '../../../packages/contracts/private/terminal-recording.js';
import { terminalCoversCutoff } from './terminal-recorder.js';
import { DynamoMonitorRecordingStore, type MonitorRecorderLease } from './monitor-recording-store.js';
import { TerminalRecordingStoreError } from './terminal-recording-store.js';
import {
  initialCommandParser,
  isCommandParserCheckpoint,
} from '../../../packages/contracts/private/command-evidence.js';
import { parseCommandEvents } from './command-parser.js';
import { stageCommandEvidence } from './command-publication.js';
import type { TerminalRecordingEvent } from '../../../packages/contracts/private/terminal-recording.js';

/** A bounded, integrity-checked live page that contains the first excluded event. */
export interface TerminalCutoffProof {
  reference: StoredTerminalPage;
  page: TerminalRecordingPage;
}

export interface TerminalSealingStore {
  get(sessionId: string, signal?: AbortSignal): Promise<TerminalSealState | undefined>;
  begin(
    lease: MonitorRecorderLease,
    checkpoint: TerminalRecordingCheckpoint,
    cutoffAt: string,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalSealState>;
  nextPage(
    sessionId: string,
    source: string,
    after: number,
    signal?: AbortSignal,
  ): Promise<StoredTerminalPage | undefined>;
  append(
    lease: MonitorRecorderLease,
    previous: TerminalSealState,
    reference: SealedTerminalPage,
    eventBytes: number,
    now: string,
    events: readonly TerminalRecordingEvent[],
    signal?: AbortSignal,
  ): Promise<TerminalSealState>;
  finish(
    lease: MonitorRecorderLease,
    previous: TerminalSealState,
    proof: TerminalCutoffProof | null,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalSealState>;
}
const key = (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: 'TERMINAL_SEAL' });
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
const options = (signal?: AbortSignal) => (signal === undefined ? undefined : { abortSignal: signal });
const validIdentity = (sessionId: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId);

export class DynamoTerminalSealingStore implements TerminalSealingStore {
  private readonly leases: DynamoMonitorRecordingStore;
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table)) throw new TerminalRecordingStoreError('invalid_config');
    this.leases = new DynamoMonitorRecordingStore(client, table);
  }
  async get(sessionId: string, signal?: AbortSignal): Promise<TerminalSealState | undefined> {
    if (!validIdentity(sessionId)) throw new TerminalRecordingStoreError('invalid_input');
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: key(sessionId), ConsistentRead: true }),
      options(signal),
    );
    if (!result.Item) return undefined;
    if (!isTerminalSealState(result.Item.data)) throw new TerminalRecordingStoreError('invalid_store');
    return structuredClone(result.Item.data);
  }
  private async check(lease: MonitorRecorderLease, cutoffAt: string, now: string, signal?: AbortSignal) {
    if (
      !validIdentity(lease.sessionId) ||
      !Number.isSafeInteger(lease.generation) ||
      lease.generation < 1 ||
      lease.generation > 999_999_999 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(lease.recorderId) ||
      !isMonitorControlTimestamp(now) ||
      !isMonitorControlTimestamp(cutoffAt) ||
      now < cutoffAt
    )
      throw new TerminalRecordingStoreError('invalid_input');
    const state = await this.leases.get(lease.sessionId, signal);
    if (
      !state ||
      state.status !== 'draining' ||
      state.cutoffAt !== cutoffAt ||
      state.recorderId !== lease.recorderId ||
      state.generation !== lease.generation ||
      state.leaseExpiresAt! <= now ||
      state.drainDeadlineAt! <= now
    )
      throw new TerminalRecordingStoreError('stale_lease');
  }
  private leaseCheck(lease: MonitorRecorderLease, cutoffAt: string, now: string) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: { PK: `SESSION#${lease.sessionId}`, SK: 'RECORDING' },
        ConditionExpression:
          '#data.#status = :draining AND #data.#cutoff = :cutoff AND #data.#owner = :owner AND #data.#generation = :generation AND #data.#expires > :now AND #data.#deadline > :now',
        ExpressionAttributeNames: {
          '#data': 'data',
          '#status': 'status',
          '#cutoff': 'cutoffAt',
          '#owner': 'recorderId',
          '#generation': 'generation',
          '#expires': 'leaseExpiresAt',
          '#deadline': 'drainDeadlineAt',
        },
        ExpressionAttributeValues: {
          ':draining': 'draining',
          ':cutoff': cutoffAt,
          ':owner': lease.recorderId,
          ':generation': lease.generation,
          ':now': now,
        },
      },
    };
  }
  async begin(
    lease: MonitorRecorderLease,
    checkpoint: TerminalRecordingCheckpoint,
    cutoffAt: string,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalSealState> {
    lease = { ...lease };
    const initial: TerminalSealState = {
      schemaVersion: 1,
      cutoffAt,
      checkpoint: structuredClone(checkpoint),
      cursor: 0,
      pageCount: 0,
      recordedBytes: 0,
      lastAt: null,
      excludedAt: null,
      complete: false,
    };
    if (!isTerminalSealState(initial) || !terminalCoversCutoff(checkpoint, cutoffAt))
      throw new TerminalRecordingStoreError('invalid_stream');
    await this.check(lease, cutoffAt, now, signal);
    const current = await this.get(lease.sessionId, signal);
    if (current) {
      if (current.cutoffAt !== cutoffAt || current.checkpoint.metadata.source !== checkpoint.metadata.source)
        throw new TerminalRecordingStoreError('invalid_stream');
      return current;
    }
    try {
      await sendDynamoWrite(
        this.client,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.leaseCheck(lease, cutoffAt, now),
            {
              ConditionCheck: {
                TableName: this.table,
                Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_RECORDING' },
                ConditionExpression: '#data = :checkpoint',
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: { ':checkpoint': initial.checkpoint },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...key(lease.sessionId), data: initial },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
        options(signal),
      );
      return initial;
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(lease.sessionId, signal);
      await this.check(lease, cutoffAt, now, signal);
      if (saved && saved.cutoffAt === cutoffAt && saved.checkpoint.metadata.source === checkpoint.metadata.source)
        return saved;
      throw error;
    }
  }
  async nextPage(
    sessionId: string,
    source: string,
    after: number,
    signal?: AbortSignal,
  ): Promise<StoredTerminalPage | undefined> {
    if (
      !validIdentity(sessionId) ||
      !validIdentity(source) ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > 100_000
    )
      throw new TerminalRecordingStoreError('invalid_input');
    const prefix = `TERMINAL_CHUNK#${source}#`;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        ConsistentRead: true,
        Limit: 1,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :low AND :high',
        ExpressionAttributeValues: {
          ':pk': `SESSION#${sessionId}`,
          ':low': `${prefix}${String(after + 1).padStart(6, '0')}`,
          ':high': `${prefix}100000`,
        },
      }),
      options(signal),
    );
    const item = result.Items?.[0];
    if (!item) return undefined;
    const data = item.data;
    const generation = typeof data?.objectKey === 'string' ? Number(data.objectKey.split('/')[3]) : NaN;
    if (
      !isStoredTerminalPage(data, sessionId, generation) ||
      data.source !== source ||
      data.after > after ||
      data.nextSequence <= after
    )
      throw new TerminalRecordingStoreError('invalid_store');
    return structuredClone(data);
  }
  async append(
    lease: MonitorRecorderLease,
    previous: TerminalSealState,
    reference: SealedTerminalPage,
    eventBytes: number,
    now: string,
    events: readonly TerminalRecordingEvent[],
    signal?: AbortSignal,
  ): Promise<TerminalSealState> {
    if (
      !isTerminalSealState(previous) ||
      previous.complete ||
      !isSealedTerminalPage(reference, lease.sessionId) ||
      reference.source !== previous.checkpoint.metadata.source ||
      reference.after !== previous.cursor ||
      reference.lastAt > previous.cutoffAt ||
      reference.firstAt < (previous.lastAt ?? previous.checkpoint.metadata.startedAt) ||
      !Number.isSafeInteger(eventBytes) ||
      eventBytes < 1 ||
      eventBytes !== events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
    )
      throw new TerminalRecordingStoreError('invalid_input');
    const next = {
      ...structuredClone(previous),
      cursor: reference.nextSequence,
      pageCount: previous.pageCount + 1,
      recordedBytes: previous.recordedBytes + eventBytes,
      lastAt: reference.lastAt,
    };
    if (!isTerminalSealState(next)) throw new TerminalRecordingStoreError('invalid_stream');
    return this.commit({ ...lease }, previous, next, reference, now, signal, undefined, events);
  }
  async finish(
    lease: MonitorRecorderLease,
    previous: TerminalSealState,
    proof: TerminalCutoffProof | null,
    now: string,
    signal?: AbortSignal,
  ): Promise<TerminalSealState> {
    if (!isTerminalSealState(previous)) throw new TerminalRecordingStoreError('invalid_input');
    previous = structuredClone(previous);
    proof = proof === null ? null : structuredClone(proof);
    let excludedAt: string | null = null;
    if (proof !== null) {
      const generation = Number(proof.reference.objectKey.split('/')[3]);
      let encoded;
      try {
        encoded = encodeTerminalPage(lease.sessionId, generation, proof.reference.after, proof.page);
      } catch {
        throw new TerminalRecordingStoreError('invalid_stream');
      }
      const firstExcluded = proof.page.events.find((event) => event.sequence === previous.cursor + 1);
      if (
        canonical(encoded.reference) !== canonical(proof.reference) ||
        proof.reference.source !== previous.checkpoint.metadata.source ||
        proof.reference.after > previous.cursor ||
        proof.reference.nextSequence > previous.checkpoint.cursor ||
        !firstExcluded ||
        firstExcluded.recordedAt <= previous.cutoffAt
      )
        throw new TerminalRecordingStoreError('invalid_stream');
      excludedAt = firstExcluded.recordedAt;
    }
    const next = { ...previous, excludedAt, complete: true };
    if (!isTerminalSealState(next) || !terminalCoversCutoff(previous.checkpoint, previous.cutoffAt))
      throw new TerminalRecordingStoreError('invalid_stream');
    if (previous.complete) {
      await this.check(lease, previous.cutoffAt, now, signal);
      const saved = await this.get(lease.sessionId, signal);
      if (canonical(saved) !== canonical(previous) || excludedAt !== previous.excludedAt)
        throw new TerminalRecordingStoreError('conflict');
      return structuredClone(previous);
    }
    return this.commit({ ...lease }, previous, next, null, now, signal, proof?.reference);
  }
  private async commit(
    lease: MonitorRecorderLease,
    previous: TerminalSealState,
    next: TerminalSealState,
    reference: SealedTerminalPage | null,
    now: string,
    signal?: AbortSignal,
    cutoffReference?: StoredTerminalPage,
    events?: readonly TerminalRecordingEvent[],
  ): Promise<TerminalSealState> {
    if (reference && !events) throw new TerminalRecordingStoreError('invalid_input');
    if (
      events &&
      (!reference ||
        canonical(
          encodeSealedTerminalPage(
            lease.sessionId,
            Number(reference.objectKey.split('/')[3]),
            reference.source,
            reference.after,
            events,
          ).reference,
        ) !== canonical(reference))
    )
      throw new TerminalRecordingStoreError('invalid_input');
    const parserKey = { PK: `SESSION#${lease.sessionId}`, SK: 'SEALED_COMMAND_PARSER' };
    const savedParser = events
      ? (
          await this.client.send(
            new GetCommand({ TableName: this.table, Key: parserKey, ConsistentRead: true }),
            options(signal),
          )
        ).Item?.data
      : undefined;
    if (events && savedParser !== undefined && !isCommandParserCheckpoint(savedParser))
      throw new TerminalRecordingStoreError('invalid_store');
    const parser = events ? (savedParser ?? initialCommandParser(previous.checkpoint.metadata.source)) : undefined;
    if (parser && parser.cursor !== previous.cursor) {
      const saved = await this.get(lease.sessionId, signal);
      if (
        reference &&
        saved &&
        saved.cursor >= next.cursor &&
        canonical(saved.checkpoint) === canonical(next.checkpoint) &&
        saved.cutoffAt === next.cutoffAt
      ) {
        const receipt = await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: {
              PK: `SESSION#${lease.sessionId}`,
              SK: `TERMINAL_SEALED_CHUNK#${reference.source}#${String(reference.nextSequence).padStart(6, '0')}`,
            },
            ConsistentRead: true,
          }),
          options(signal),
        );
        if (canonical(receipt.Item?.data) === canonical(reference)) return next;
      }
      throw new TerminalRecordingStoreError('conflict');
    }
    const derived = parser && events ? parseCommandEvents(parser, events) : undefined;
    const snapshot = structuredClone(previous);
    reference = reference === null ? null : structuredClone(reference);
    await this.check(lease, next.cutoffAt, now, signal);
    const pageKey =
      reference === null
        ? null
        : {
            PK: `SESSION#${lease.sessionId}`,
            SK: `TERMINAL_SEALED_CHUNK#${reference.source}#${String(reference.nextSequence).padStart(6, '0')}`,
          };
    try {
      const publication = derived
        ? await stageCommandEvidence(
            this.client,
            this.table,
            lease.sessionId,
            'SEALED_COMMAND',
            derived.commands,
            [
              this.leaseCheck(lease, next.cutoffAt, now),
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
          )
        : undefined;
      await sendDynamoWrite(
        this.client,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.leaseCheck(lease, next.cutoffAt, now),
            ...(derived
              ? [
                  {
                    Put: {
                      TableName: this.table,
                      Item: { ...parserKey, data: derived.checkpoint },
                      ConditionExpression: savedParser ? '#data = :expected' : 'attribute_not_exists(PK)',
                      ...(savedParser
                        ? {
                            ExpressionAttributeNames: { '#data': 'data' },
                            ExpressionAttributeValues: { ':expected': savedParser },
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
                              SK: `SEALED_COMMAND#${String(publication.first).padStart(6, '0')}`,
                              data: publication,
                            },
                            ConditionExpression: 'attribute_not_exists(PK)',
                          },
                        },
                      ]
                    : derived.commands.map((data) => ({
                        Put: {
                          TableName: this.table,
                          Item: {
                            PK: `SESSION#${lease.sessionId}`,
                            SK: `SEALED_COMMAND#${String(data.seq).padStart(6, '0')}`,
                            data,
                          },
                          ConditionExpression: 'attribute_not_exists(PK)',
                        },
                      }))),
                ]
              : []),
            ...(cutoffReference
              ? [
                  {
                    ConditionCheck: {
                      TableName: this.table,
                      Key: {
                        PK: `SESSION#${lease.sessionId}`,
                        SK: `TERMINAL_CHUNK#${cutoffReference.source}#${String(cutoffReference.nextSequence).padStart(6, '0')}`,
                      },
                      ConditionExpression: '#data = :reference',
                      ExpressionAttributeNames: { '#data': 'data' },
                      ExpressionAttributeValues: { ':reference': cutoffReference },
                    },
                  },
                ]
              : []),
            {
              Put: {
                TableName: this.table,
                Item: { ...key(lease.sessionId), data: next },
                ConditionExpression: '#data = :previous',
                ExpressionAttributeNames: { '#data': 'data' },
                ExpressionAttributeValues: { ':previous': snapshot },
              },
            },
            ...(pageKey === null
              ? []
              : [
                  {
                    Put: {
                      TableName: this.table,
                      Item: { ...pageKey, data: reference },
                      ConditionExpression: 'attribute_not_exists(PK)',
                    },
                  },
                ]),
          ],
        }),
        options(signal),
      );
      return next;
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(lease.sessionId, signal);
      if (pageKey === null && canonical(saved) === canonical(next)) return next;
      if (
        pageKey &&
        saved &&
        saved.cursor >= next.cursor &&
        saved.cutoffAt === next.cutoffAt &&
        canonical(saved.checkpoint) === canonical(next.checkpoint)
      ) {
        const item = await this.client.send(
          new GetCommand({ TableName: this.table, Key: pageKey, ConsistentRead: true }),
          options(signal),
        );
        if (canonical(item.Item?.data) === canonical(reference)) return next;
      }
      await this.check(lease, next.cutoffAt, now, signal);
      if (
        error instanceof Error &&
        ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name)
      )
        throw new TerminalRecordingStoreError('conflict');
      throw error;
    }
  }
}
