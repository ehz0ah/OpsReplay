import { randomUUID, createHash } from 'node:crypto';
import { sendDynamoWrite } from '../../../packages/dynamodb/src/conflict-retry.js';
import { isCaptureCoverage, type CaptureCoverage } from '../../../packages/contracts/private/capture-coverage.js';
import type { TerminalRecordingCheckpoint } from '../../../packages/contracts/private/terminal-persistence.js';
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import {
  isCommandEvidence,
  isCommandParserCheckpoint,
  type CommandParserCheckpoint,
} from '../../../packages/contracts/private/command-evidence.js';
import {
  captureLimits,
  isCaptureBaseline,
  isFileCapture,
  type CaptureBaseline,
  type CaptureRequest,
  type FileCapture,
} from '../../../packages/contracts/private/file-capture.js';
import { recordingRetention } from '../../../packages/contracts/private/recording-retention.js';
import type { MonitorRecorderLease } from './monitor-recording-store.js';
import { TerminalRecordingStoreError } from './terminal-recording-store.js';

import { CommandEvidenceReadError, readCommandPage } from '../../../packages/session/src/command-reader.js';
import { canonicalJson } from '../../../packages/session/src/canonical.js';
import { isCaptureState, type CaptureState } from '../../../packages/contracts/private/capture-persistence.js';
import { isMonitorRecordingIdentity } from './monitor-recording-identity.js';
import { isMonitorControlTimestamp } from '../../../packages/contracts/private/monitor-control.js';
export interface CaptureClient {
  baseline(signal?: AbortSignal): Promise<CaptureBaseline>;
  capture(value: CaptureRequest, signal?: AbortSignal): Promise<FileCapture>;
}
/** Separate saved capture cursor, same recording lease. Page commit can succeed
 * before capture; replay reads outstanding command IDs and the Monitor receipt. */
export class CaptureRecorder {
  constructor(
    private readonly dynamo: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly client: CaptureClient,
    private readonly now = () => new Date().toISOString(),
  ) {
    if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
      throw new TerminalRecordingStoreError('invalid_config');
  }
  private validate(lease: MonitorRecorderLease): void {
    if (
      !isMonitorRecordingIdentity(lease.sessionId, lease.generation) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(lease.recorderId) ||
      !isMonitorControlTimestamp(this.now())
    )
      throw new TerminalRecordingStoreError('invalid_input');
  }
  private key(sessionId: string) {
    return { PK: `SESSION#${sessionId}`, SK: 'CAPTURE_STATE' };
  }
  private async state(sessionId: string, signal: AbortSignal): Promise<CaptureState | undefined> {
    const result = await this.dynamo.send(
      new GetCommand({ TableName: this.table, Key: this.key(sessionId), ConsistentRead: true }),
      { abortSignal: signal },
    );
    if (!result.Item) return undefined;
    if (!isCaptureState(result.Item.data)) throw new TerminalRecordingStoreError('invalid_store');
    return structuredClone(result.Item.data);
  }
  private lease(lease: MonitorRecorderLease) {
    return {
      ConditionCheck: {
        TableName: this.table,
        Key: { PK: `SESSION#${lease.sessionId}`, SK: 'RECORDING' },
        ConditionExpression:
          '#d.#owner = :owner AND #d.#generation = :generation AND #d.#expires > :now AND (#d.#status = :recording OR (#d.#status = :draining AND #d.#deadline > :now))',
        ExpressionAttributeNames: {
          '#d': 'data',
          '#owner': 'recorderId',
          '#generation': 'generation',
          '#expires': 'leaseExpiresAt',
          '#status': 'status',
          '#deadline': 'drainDeadlineAt',
        },
        ExpressionAttributeValues: {
          ':owner': lease.recorderId,
          ':generation': lease.generation,
          ':now': this.now(),
          ':recording': 'recording',
          ':draining': 'draining',
        },
      },
    };
  }
  async baseline(lease: MonitorRecorderLease, signal: AbortSignal): Promise<void> {
    this.validate(lease);
    lease = { ...lease };
    if (await this.state(lease.sessionId, signal)) return;
    const baseline = await this.client.baseline(signal);
    if (!isCaptureBaseline(baseline)) throw new TerminalRecordingStoreError('invalid_stream');
    const next: CaptureState = {
      schemaVersion: 1,
      baseline,
      cursor: 0,
      sequence: 0,
      retainedBytes: 0,
      incomplete: baseline.incomplete,
      unavailable: baseline.unavailable,
    };
    try {
      await sendDynamoWrite(
        this.dynamo,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.lease(lease),
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
                Item: { ...this.key(lease.sessionId), data: next },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      if (canonicalJson(await this.state(lease.sessionId, signal)) !== canonicalJson(next))
        await this.failure(lease, error, signal);
    }
  }
  private async failure(lease: MonitorRecorderLease, error: unknown, signal: AbortSignal): Promise<never> {
    const row = (
      await this.dynamo.send(
        new GetCommand({
          TableName: this.table,
          Key: { PK: `SESSION#${lease.sessionId}`, SK: 'RECORDING' },
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      )
    ).Item?.data;
    if (
      !row ||
      row.recorderId !== lease.recorderId ||
      row.generation !== lease.generation ||
      row.leaseExpiresAt <= this.now()
    )
      throw new TerminalRecordingStoreError('stale_lease');
    if (
      error instanceof Error &&
      ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(error.name)
    )
      throw new TerminalRecordingStoreError('conflict');
    throw error;
  }
  async finish(
    lease: MonitorRecorderLease,
    terminal: TerminalRecordingCheckpoint,
    cutoffAt: string,
    signal: AbortSignal,
    parser: CommandParserCheckpoint,
  ): Promise<void> {
    this.validate(lease);
    lease = { ...lease };
    terminal = structuredClone(terminal);
    parser = structuredClone(parser);
    if (!isCommandParserCheckpoint(parser)) throw new TerminalRecordingStoreError('invalid_input');
    const coverageKey = { PK: `SESSION#${lease.sessionId}`, SK: 'CAPTURE_COVERAGE' };
    const existing = (
      await this.dynamo.send(new GetCommand({ TableName: this.table, Key: coverageKey, ConsistentRead: true }), {
        abortSignal: signal,
      })
    ).Item?.data;
    if (existing !== undefined) {
      if (
        !isCaptureCoverage(existing) ||
        existing.cutoffAt !== cutoffAt ||
        canonicalJson(existing.terminal) !== canonicalJson(terminal) ||
        canonicalJson(existing.parser) !== canonicalJson(parser)
      )
        throw new TerminalRecordingStoreError('conflict');
      return;
    }
    await this.collect(lease, signal, parser);
    const captures = await this.state(lease.sessionId, signal);
    const receipt: CaptureCoverage = { schemaVersion: 1, cutoffAt, terminal, parser, captures: captures! };
    if (!isCaptureCoverage(receipt)) throw new TerminalRecordingStoreError('invalid_stream');
    const Key = coverageKey;
    try {
      await sendDynamoWrite(
        this.dynamo,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            this.lease(lease),
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
                Key: { PK: `SESSION#${lease.sessionId}`, SK: 'TERMINAL_RECORDING' },
                ConditionExpression: '#d = :terminal',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':terminal': terminal },
              },
            },
            {
              ConditionCheck: {
                TableName: this.table,
                Key: this.key(lease.sessionId),
                ConditionExpression: '#d = :captures',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':captures': captures },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { ...Key, data: receipt },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      const saved = (
        await this.dynamo.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }), {
          abortSignal: signal,
        })
      ).Item?.data;
      if (canonicalJson(saved) !== canonicalJson(receipt)) await this.failure(lease, error, signal);
    }
  }
  async collect(
    lease: MonitorRecorderLease,
    signal: AbortSignal,
    cutoffParser?: CommandParserCheckpoint,
  ): Promise<void> {
    this.validate(lease);
    lease = { ...lease };
    let state = await this.state(lease.sessionId, signal);
    if (!state) throw new TerminalRecordingStoreError('invalid_store');
    const saved =
      cutoffParser ??
      (
        await this.dynamo.send(
          new GetCommand({
            TableName: this.table,
            Key: { PK: `SESSION#${lease.sessionId}`, SK: 'COMMAND_PARSER' },
            ConsistentRead: true,
          }),
          { abortSignal: signal },
        )
      ).Item?.data;
    if (!isCommandParserCheckpoint(saved)) throw new TerminalRecordingStoreError('invalid_store');
    const parser = structuredClone(saved);
    const target = parser.count - (!cutoffParser && parser.active ? 1 : 0);
    do {
      signal.throwIfAborted();
      if (state.cursor >= target) return;
      const prefix = 'COMMAND';
      const completedTarget = cutoffParser && parser.active ? target - 1 : target;
      const rows = await readCommandPage(
        this.dynamo,
        this.table,
        lease.sessionId,
        prefix,
        state.cursor,
        completedTarget,
        signal,
      ).catch((error: unknown) => {
        if (error instanceof CommandEvidenceReadError) throw new TerminalRecordingStoreError('invalid_store');
        throw error;
      });
      if (
        cutoffParser &&
        parser.active &&
        state.cursor + rows.length === completedTarget &&
        parser.active.event.seq > state.cursor
      )
        rows.push(parser.active.event);
      if (rows.length === 0) {
        if (cutoffParser && state.cursor < target) throw new TerminalRecordingStoreError('invalid_store');
        return;
      }
      for (const command of rows) {
        if (!isCommandEvidence(command)) throw new TerminalRecordingStoreError('invalid_store');
        if (command.seq !== state.cursor + 1) throw new TerminalRecordingStoreError('invalid_store');
        const capture = await this.client.capture({ commandId: command.id, commandSeq: command.seq }, signal);
        const previousAt = state.baseline.baselineAt;
        if (
          !isFileCapture(capture) ||
          capture.commandId !== command.id ||
          capture.commandSeq !== command.seq ||
          capture.sequence !== state.sequence + 1 ||
          capture.startedAt < (command.endedAt ?? command.at) ||
          capture.baselineAt !== previousAt
        )
          throw new TerminalRecordingStoreError('invalid_stream');
        const body = Buffer.from(canonicalJson(capture));
        if (state.retainedBytes + body.length > captureLimits.maximumRetainedBytes)
          throw new TerminalRecordingStoreError('invalid_stream');
        const sha256 = createHash('sha256').update(body).digest('hex');
        const objectKey = `sessions/${lease.sessionId}/captures/${String(lease.generation).padStart(9, '0')}/${String(command.seq).padStart(6, '0')}-${sha256}.json`;
        const put = new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: body,
          ContentLength: body.length,
          ContentType: 'application/json; charset=utf-8',
          CacheControl: 'no-store',
          ServerSideEncryption: 'AES256',
          IfNoneMatch: '*',
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
          Tagging: `${recordingRetention.tagKey}=${recordingRetention.sealedTagValue}`,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await this.s3.send(put, { abortSignal: signal });
            break;
          } catch (error) {
            if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) break;
            if (attempt === 0 && error instanceof S3ServiceException && error.name === 'ConditionalRequestConflict')
              continue;
            throw error;
          }
        }
        const next: CaptureState = {
          ...state,
          cursor: command.seq,
          sequence: capture.sequence,
          baseline: { ...state.baseline, baselineAt: capture.startedAt },
          retainedBytes: state.retainedBytes + body.length,
          incomplete: state.incomplete || capture.incomplete,
          unavailable: state.unavailable || capture.unavailable,
        };
        const reference = {
          schemaVersion: 1,
          objectKey,
          sha256,
          byteLength: body.length,
          commandId: command.id,
          commandSeq: command.seq,
          sequence: capture.sequence,
          baselineAt: capture.baselineAt,
          startedAt: capture.startedAt,
          completedAt: capture.completedAt,
          incomplete: capture.incomplete,
        };
        const key = { PK: `SESSION#${lease.sessionId}`, SK: `CAPTURE#${String(command.seq).padStart(6, '0')}` };
        try {
          await sendDynamoWrite(
            this.dynamo,
            new TransactWriteCommand({
              ClientRequestToken: randomUUID(),
              TransactItems: [
                this.lease(lease),
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
                    Key: { PK: `SESSION#${lease.sessionId}`, SK: 'CAPTURE_COVERAGE' },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
                {
                  Put: {
                    TableName: this.table,
                    Item: { ...this.key(lease.sessionId), data: next },
                    ConditionExpression: '#d = :previous',
                    ExpressionAttributeNames: { '#d': 'data' },
                    ExpressionAttributeValues: { ':previous': state },
                  },
                },
                {
                  Put: {
                    TableName: this.table,
                    Item: { ...key, data: reference },
                    ConditionExpression: 'attribute_not_exists(PK)',
                  },
                },
              ],
            }),
            { abortSignal: signal },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          const saved = await this.dynamo.send(
            new GetCommand({ TableName: this.table, Key: key, ConsistentRead: true }),
            { abortSignal: signal },
          );
          if (canonicalJson(saved.Item?.data) !== canonicalJson(reference)) await this.failure(lease, error, signal);
        }
        state = next;
      }
      if (!cutoffParser) return;
    } while (state.cursor < target);
  }
}
