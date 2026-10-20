import { randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { validLock, validReceipt, validSession, validSessionRelations } from '../start-session/validation.js';
import {
  isTerminalOwnerId,
  isTerminalSessionId,
  isTerminalTimestamp,
} from '../../../../packages/contracts/private/terminal-access.js';
import { isMonitorRecordingState } from '../../../../packages/contracts/private/monitor-persistence.js';
import { isSessionLifecycleState } from '../../../../packages/contracts/private/session-lifecycle.js';
import { isPlaybackExportState } from '../../../../packages/contracts/private/playback-persistence.js';
import { historyKey } from '../../../../packages/session/src/history.js';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import { sendDynamoWrite } from '../../../../packages/dynamodb/src/conflict-retry.js';

type Key = { PK: string; SK: string };
interface Deletion {
  schemaVersion: 1;
  ownerId: string;
  sessionId: string;
  claimedAt: string;
  receiptKey: Key;
  historyKey: Key;
}
export class DeletionError extends Error {
  constructor(
    readonly code:
      'INVALID_REQUEST' | 'NOT_FOUND' | 'NOT_QUIESCENT' | 'INVALID_STORE' | 'UNSUPPORTED_BUCKET' | 'CONFLICT',
  ) {
    super(code);
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const key = (id: string, SK: string): Key => ({ PK: 'SESSION#' + id, SK });
const maximumPages = 1000;
// Covers the 70-second assistant Lambda and the 60-second lifecycle Lambda.
// No new producer can start after terminal state and retired work.
export const deletionQuietMs = 120_000;

/** Operator-only, one-session erasure. No task control, table scan or account deletion. */
export class SessionDeletion {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly now = Date.now,
  ) {}

  private async get(Key: Key, signal: AbortSignal) {
    return (
      await this.db.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }), { abortSignal: signal })
    ).Item;
  }
  private condition(Key: Key, data: unknown) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key,
        ConditionExpression: data === undefined ? 'attribute_not_exists(PK)' : '#d = :before',
        ...(data === undefined
          ? {}
          : { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':before': data } }),
      },
    };
  }
  private async page(PK: string, prefix: string, after: Key | undefined, signal: AbortSignal) {
    const result = await this.db.send(
      new QueryCommand({
        TableName: this.table,
        ConsistentRead: true,
        Limit: 100,
        KeyConditionExpression: prefix ? 'PK = :pk AND begins_with(SK, :prefix)' : 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PK, ...(prefix ? { ':prefix': prefix } : {}) },
        ...(after ? { ExclusiveStartKey: after } : {}),
      }),
      { abortSignal: signal },
    );
    for (const row of result.Items ?? [])
      if (row.PK !== PK || typeof row.SK !== 'string' || !row.SK.startsWith(prefix))
        throw new DeletionError('INVALID_STORE');
    const next = result.LastEvaluatedKey;
    if (
      next &&
      (next.PK !== PK || typeof next.SK !== 'string' || !next.SK.startsWith(prefix) || (after && next.SK <= after.SK))
    )
      throw new DeletionError('INVALID_STORE');
    return { rows: result.Items ?? [], after: next as Key | undefined };
  }
  private marker(v: unknown, owner: string, id: string): Deletion {
    if (
      !object(v) ||
      Object.keys(v).length !== 6 ||
      v.schemaVersion !== 1 ||
      v.ownerId !== owner ||
      v.sessionId !== id ||
      !isTerminalTimestamp(v.claimedAt) ||
      !object(v.receiptKey) ||
      Object.keys(v.receiptKey).length !== 2 ||
      v.receiptKey.PK !== 'USER#' + owner ||
      typeof v.receiptKey.SK !== 'string' ||
      !v.receiptKey.SK.startsWith('START#') ||
      !isTerminalSessionId(v.receiptKey.SK.slice(6)) ||
      !object(v.historyKey) ||
      Object.keys(v.historyKey).length !== 2 ||
      v.historyKey.PK !== 'USER#' + owner ||
      typeof v.historyKey.SK !== 'string' ||
      !v.historyKey.SK.startsWith('HISTORY#session#') ||
      v.historyKey.SK !== historyKey(owner, 'session', v.historyKey.SK.slice(16, 40), id).SK
    )
      throw new DeletionError('INVALID_STORE');
    return v as unknown as Deletion;
  }
  private async claim(owner: string, id: string, signal: AbortSignal): Promise<Deletion | undefined> {
    const existing = await this.get(key(id, 'DELETION'), signal);
    if (existing) return this.marker(existing.data, owner, id);
    const state = await this.get(key(id, 'STATE'), signal);
    if (!state) return undefined;
    const session = state.data;
    if (!object(session) || session.ownerId !== owner) throw new DeletionError('NOT_FOUND');
    if (!validSession(session) || !validSessionRelations(session) || session.view.id !== id)
      throw new DeletionError('INVALID_STORE');
    const lifecycle = await this.get(key(id, 'LIFECYCLE'), signal);
    const recording = await this.get(key(id, 'RECORDING'), signal);
    const playback = await this.get(key(id, 'PLAYBACK_EXPORT'), signal);
    const lock = await this.get({ PK: 'USER#' + owner, SK: 'ACTIVE' }, signal);
    if (lock && !validLock(lock.data)) throw new DeletionError('INVALID_STORE');
    if (
      ['provisioning', 'ready'].includes(session.view.status) ||
      !session.view.endedAt ||
      !isTerminalTimestamp(session.view.endedAt) ||
      !isSessionLifecycleState(lifecycle?.data, id) ||
      !lifecycle.data.taskStoppedAt ||
      lifecycle.data.taskStoppedAt < session.view.endedAt ||
      !lifecycle.data.schedulesDeleted ||
      lock?.data.sessionId === id ||
      state.WorkPK !== undefined ||
      state.WorkSK !== undefined ||
      lifecycle.WorkPK !== undefined ||
      lifecycle.WorkSK !== undefined
    )
      throw new DeletionError('NOT_QUIESCENT');
    if (session.view.readyAt === null) {
      const neverRecorded = !recording && session.view.recording.status === 'pending';
      const stoppedBeforeReady =
        isMonitorRecordingState(recording?.data, id) &&
        recording.data.status === 'incomplete' &&
        session.view.recording.status === 'incomplete' &&
        recording.data.cutoffAt === session.view.endedAt;
      if (playback || (!neverRecorded && !stoppedBeforeReady)) throw new DeletionError('NOT_QUIESCENT');
    } else if (
      !session.view.debriefAvailable ||
      !isMonitorRecordingState(recording?.data, id) ||
      !['complete', 'incomplete'].includes(recording.data.status) ||
      recording.data.status !== session.view.recording.status ||
      recording.data.cutoffAt !== session.view.endedAt ||
      !isPlaybackExportState(playback?.data) ||
      !playback.data.complete
    )
      throw new DeletionError('NOT_QUIESCENT');
    // All remaining producers must be retired, including an expired assistant turn.
    let after: Key | undefined;
    for (let n = 0; ; n++) {
      if (n >= maximumPages) throw new DeletionError('INVALID_STORE');
      const page = await this.page('SESSION#' + id, '', after, signal);
      if (page.rows.some((r) => r.WorkPK !== undefined || r.WorkSK !== undefined))
        throw new DeletionError('NOT_QUIESCENT');
      after = page.after;
      if (!after) break;
    }
    let receipt: Key | undefined, receiptData: unknown;
    after = undefined;
    for (let n = 0; ; n++) {
      if (n >= maximumPages) throw new DeletionError('INVALID_STORE');
      const page = await this.page('USER#' + owner, 'START#', after, signal);
      for (const row of page.rows) {
        if (!validReceipt(row.data) || row.data.ownerId !== owner || row.SK !== 'START#' + row.data.requestId)
          throw new DeletionError('INVALID_STORE');
        if (row.data.sessionId === id) {
          if (receipt) throw new DeletionError('INVALID_STORE');
          receipt = { PK: row.PK as string, SK: row.SK as string };
          receiptData = row.data;
        }
      }
      after = page.after;
      if (!after) break;
    }
    if (!receipt) throw new DeletionError('INVALID_STORE');
    const marker: Deletion = {
      schemaVersion: 1,
      ownerId: owner,
      sessionId: id,
      claimedAt: new Date(this.now()).toISOString(),
      receiptKey: receipt,
      historyKey: historyKey(owner, 'session', session.view.createdAt, id),
    };
    await sendDynamoWrite(
      this.db,
      new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          {
            Delete: {
              TableName: this.table,
              Key: key(id, 'STATE'),
              ConditionExpression: '#d = :s AND attribute_not_exists(WorkPK) AND attribute_not_exists(WorkSK)',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':s': session },
            },
          },
          {
            ConditionCheck: {
              ...this.condition(key(id, 'LIFECYCLE'), lifecycle.data).ConditionCheck,
              ConditionExpression: '#d = :before AND attribute_not_exists(WorkPK) AND attribute_not_exists(WorkSK)',
            },
          },
          this.condition(key(id, 'RECORDING'), recording?.data),
          this.condition(key(id, 'PLAYBACK_EXPORT'), playback?.data),
          this.condition({ PK: 'USER#' + owner, SK: 'ACTIVE' }, lock?.data),
          this.condition(receipt, receiptData),
          {
            Put: {
              TableName: this.table,
              Item: { ...key(id, 'DELETION'), data: marker },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
      { abortSignal: signal },
    );
    return marker;
  }
  private async objects(id: string, remove: boolean, signal: AbortSignal) {
    const prefix = `sessions/${id}/`;
    for (let page = 0; ; page++) {
      if (page >= maximumPages) throw new DeletionError('INVALID_STORE');
      const result = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1000 }),
        { abortSignal: signal },
      );
      const objects = result.Contents ?? [];
      if (objects.some((v) => !v.Key?.startsWith(prefix)) || (result.IsTruncated && !objects.length))
        throw new DeletionError('INVALID_STORE');
      if (!objects.length) return true;
      if (!remove) return false;
      const deleted = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Quiet: true, Objects: objects.map((v) => ({ Key: v.Key! })) },
        }),
        { abortSignal: signal },
      );
      if (deleted.Errors?.length) throw new DeletionError('CONFLICT');
      // Restart the listing after each delete. This also verifies the last page is gone.
    }
  }
  async run(owner: string, id: string, signal: AbortSignal): Promise<'pending' | 'deleted' | 'absent'> {
    if (!isTerminalOwnerId(owner) || !isTerminalSessionId(id)) throw new DeletionError('INVALID_REQUEST');
    signal.throwIfAborted();
    const versioning = await this.s3.send(new GetBucketVersioningCommand({ Bucket: this.bucket }), {
      abortSignal: signal,
    });
    if (versioning.Status !== undefined || versioning.MFADelete === 'Enabled')
      throw new DeletionError('UNSUPPORTED_BUCKET');
    const marker = await this.claim(owner, id, signal);
    if (!marker) {
      const remaining = await this.page('SESSION#' + id, '', undefined, signal);
      if (remaining.rows.length || !(await this.objects(id, false, signal))) throw new DeletionError('CONFLICT');
      // A lost final response is safe to replay only if owner references are gone too.
      for (const prefix of ['START#', 'HISTORY#session#']) {
        let after: Key | undefined;
        for (let n = 0; ; n++) {
          if (n >= maximumPages) throw new DeletionError('INVALID_STORE');
          const page = await this.page('USER#' + owner, prefix, after, signal);
          if (page.rows.some((r) => r.data?.sessionId === id || r.data?.id === id)) throw new DeletionError('CONFLICT');
          after = page.after;
          if (!after) break;
        }
      }
      return 'absent';
    }
    if (this.now() < Date.parse(marker.claimedAt) + deletionQuietMs) return 'pending';
    await this.objects(id, true, signal);
    // Keep the marker until owner references can disappear atomically.
    for (let n = 0; ; n++) {
      if (n >= maximumPages) throw new DeletionError('INVALID_STORE');
      const page = await this.page('SESSION#' + id, '', undefined, signal);
      if (page.rows.some((r) => r.SK === 'STATE')) throw new DeletionError('CONFLICT');
      const rows = page.rows.filter((r) => r.SK !== 'DELETION');
      if (!rows.length) break;
      await sendDynamoWrite(
        this.db,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.condition(key(id, 'DELETION'), marker),
            ...rows.slice(0, 99).map((r) => ({ Delete: { TableName: this.table, Key: { PK: r.PK, SK: r.SK } } })),
          ],
        }),
        { abortSignal: signal },
      );
    }
    if (!(await this.objects(id, false, signal))) throw new DeletionError('CONFLICT');
    const receipt = await this.get(marker.receiptKey, signal);
    const history = await this.get(marker.historyKey, signal);
    if (receipt && (!validReceipt(receipt.data) || receipt.data.ownerId !== owner || receipt.data.sessionId !== id))
      throw new DeletionError('CONFLICT');
    if (history && !same(history.data, { schemaVersion: 1, id, at: marker.historyKey.SK.slice(16, 40) }))
      throw new DeletionError('INVALID_STORE');
    await sendDynamoWrite(
      this.db,
      new TransactWriteCommand({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          {
            Delete: {
              TableName: this.table,
              Key: key(id, 'DELETION'),
              ConditionExpression: '#d = :m',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':m': marker },
            },
          },
          this.condition(key(id, 'STATE'), undefined),
          ...[
            [marker.receiptKey, receipt?.data],
            [marker.historyKey, history?.data],
          ].map(([Key, data]) => ({
            Delete: {
              TableName: this.table,
              Key: Key as Key,
              ConditionExpression: data === undefined ? 'attribute_not_exists(PK)' : '#d = :before',
              ...(data === undefined
                ? {}
                : { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':before': data } }),
            },
          })),
        ],
      }),
      { abortSignal: signal },
    );
    if (
      (await this.page('SESSION#' + id, '', undefined, signal)).rows.length ||
      !(await this.objects(id, false, signal))
    )
      throw new DeletionError('CONFLICT');
    if ((await this.get(marker.receiptKey, signal)) || (await this.get(marker.historyKey, signal)))
      throw new DeletionError('CONFLICT');
    return 'deleted';
  }
}
