import { expandCommandRow } from './command-reader.js';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { isCommandParserCheckpoint, type CommandEvidence } from '../../contracts/private/command-evidence.js';
import { isTerminalSealState } from '../../contracts/private/terminal-sealing.js';
import { commandId, commandEvidenceLimits } from '../../contracts/private/command-evidence.js';
import { isMonitorEvidencePage } from '../../contracts/private/monitor-evidence.js';
import { isMonitorRecordingState, type MonitorRecordingState } from '../../contracts/private/monitor-persistence.js';
import { isMonitorControlTimestamp } from '../../contracts/private/monitor-control.js';
import { isMonitorMetricFrame, isMonitorPayload, type MonitorFrame } from '../../../apps/gateway/src/monitor-client.js';
// Command events are derived atomically while the terminal seal advances.
import { readRecordingObject } from './object-reader.js';
import type { DebriefMonitorEvent } from './debrief.js';
import type { SessionRecord } from '../../../apps/api/src/start-session/types.js';

export interface RecordedEvidence {
  commands: CommandEvidence[];
  events: DebriefMonitorEvent[];
  counters: { totalRequests: number; failedRequests: number } | null;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Reads bounded private references. Sealed commands were derived with the exact
 * terminal prefix, so post-cutoff output cannot create observed evidence. */
export class RecordedEvidenceReader {
  constructor(
    private readonly dynamo: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}
  private async get(id: string, SK: string, signal?: AbortSignal): Promise<unknown> {
    return (
      await this.dynamo.send(
        new GetCommand({ TableName: this.table, Key: { PK: `SESSION#${id}`, SK }, ConsistentRead: true }),
        signal ? { abortSignal: signal } : undefined,
      )
    ).Item?.data as unknown;
  }
  private async rows(
    id: string,
    prefix: string,
    consume: (rows: Record<string, unknown>[]) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    let cursor: Record<string, unknown> | undefined;
    let count = 0;
    do {
      signal?.throwIfAborted();
      const result = await this.dynamo.send(
        new QueryCommand({
          TableName: this.table,
          ConsistentRead: true,
          Limit: 100,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
          ExpressionAttributeValues: { ':pk': `SESSION#${id}`, ':prefix': prefix },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      count += result.Items?.length ?? 0;
      if (
        count > (prefix === 'MONITOR_EVENTS#' ? 10000 : 5000) ||
        (result.LastEvaluatedKey &&
          (result.LastEvaluatedKey.PK !== `SESSION#${id}` ||
            typeof result.LastEvaluatedKey.SK !== 'string' ||
            !result.LastEvaluatedKey.SK.startsWith(prefix) ||
            (cursor !== undefined && result.LastEvaluatedKey.SK <= (cursor.SK as string))))
      )
        throw new Error('Invalid evidence pagination.');
      await consume(result.Items ?? []);
      cursor = result.LastEvaluatedKey;
    } while (cursor);
  }
  private async commands(session: SessionRecord, complete: boolean, signal?: AbortSignal): Promise<CommandEvidence[]> {
    const id = session.view.id;
    const commands: CommandEvidence[] = [];
    let commandBytes = 0;
    const add = (values: CommandEvidence[]) => {
      commandBytes += values.reduce((n, v) => n + Buffer.byteLength(JSON.stringify(v)), 0);
      if (
        commands.length + values.length > 5000 ||
        commandBytes > commandEvidenceLimits.maximumRetainedBytes + commandEvidenceLimits.maximumEventBytes
      )
        throw new Error('Command evidence limit exceeded.');
      commands.push(...values);
    };
    if (!complete) {
      const parser = await this.get(id, 'COMMAND_PARSER', signal);
      if (parser !== undefined && !isCommandParserCheckpoint(parser))
        throw new Error('Invalid command parser evidence.');
      await this.rows(
        id,
        'COMMAND#',
        async (rows) => {
          const values: CommandEvidence[] = [];
          for (const row of rows) {
            const expanded = await expandCommandRow(this.dynamo, this.table, id, 'COMMAND', row, signal);
            for (const command of expanded) {
              if (
                !isCommandParserCheckpoint(parser) ||
                command.id !== commandId(parser.source, command.seq) ||
                command.seq > parser.count - (parser.active ? 1 : 0)
              )
                throw new Error('Invalid command evidence.');
              values.push(command);
            }
          }
          add(values);
        },
        signal,
      );
      // Missing parser evidence remains incomplete. No raw input proves completion.
      if (isCommandParserCheckpoint(parser) && parser.active) add([parser.active.event]);
      return commands.map((command) =>
        command.endedAt === null || command.endedAt > session.view.endedAt!
          ? {
              ...command,
              command: '[unfinished command unavailable]',
              endedAt: null,
              exitStatus: null,
              outputExcerpt: '',
              outputTruncated: true,
            }
          : command,
      );
    }
    const seal = await this.get(id, 'TERMINAL_SEAL', signal);
    if (!isTerminalSealState(seal) || !seal.complete || seal.cutoffAt !== session.view.endedAt)
      throw new Error('Terminal evidence is not sealed.');
    const parser = await this.get(id, 'SEALED_COMMAND_PARSER', signal);
    if (
      parser === undefined
        ? seal.cursor !== 0
        : !isCommandParserCheckpoint(parser) ||
          parser.cursor !== seal.cursor ||
          parser.source !== seal.checkpoint.metadata.source ||
          parser.lossAt !== null ||
          parser.mode !== 'text' ||
          parser.utf8Tail !== '' ||
          (seal.cursor === 0 && parser.count !== 0)
    )
      throw new Error('Terminal evidence has a gap.');
    await this.rows(
      id,
      'SEALED_COMMAND#',
      async (rows) => {
        const values: CommandEvidence[] = [];
        for (const row of rows) {
          const expanded = await expandCommandRow(this.dynamo, this.table, id, 'SEALED_COMMAND', row, signal);
          for (const command of expanded) {
            if (
              !isCommandParserCheckpoint(parser) ||
              command.seq !== commands.length + values.length + 1 ||
              command.id !== commandId(parser.source, command.seq)
            )
              throw new Error('Invalid sealed command evidence.');
            values.push(command);
          }
        }
        add(values);
      },
      signal,
    );
    if (isCommandParserCheckpoint(parser)) {
      if (commands.length !== parser.count - (parser.active === null ? 0 : 1))
        throw new Error('Command evidence has a gap.');
      if (parser.active) add([parser.active.event]);
    }
    return commands;
  }
  private async monitor(
    session: SessionRecord,
    recording: MonitorRecordingState,
    signal?: AbortSignal,
  ): Promise<Pick<RecordedEvidence, 'events' | 'counters'>> {
    if (!recording.sealed) {
      const events: DebriefMonitorEvent[] = [];
      let cursor = 0;
      await this.rows(
        session.view.id,
        'MONITOR_EVENTS#',
        async (rows) => {
          for (const row of rows) {
            if (
              !isMonitorEvidencePage(row.data) ||
              row.SK !== `MONITOR_EVENTS#${String(row.data.nextSequence).padStart(6, '0')}` ||
              row.data.source !== recording.source ||
              row.data.after !== cursor ||
              row.data.nextSequence > recording.cursor
            )
              throw new Error('Invalid partial Monitor evidence.');
            cursor = row.data.nextSequence;
            for (const item of row.data.events) {
              if (
                item.recordedAt >= session.view.readyAt! &&
                item.recordedAt <= session.view.endedAt! &&
                item.event.at >= session.view.readyAt! &&
                item.event.at <= session.view.endedAt!
              )
                events.push(item.event);
            }
            if (events.length > 10000) throw new Error('Monitor evidence limit exceeded.');
          }
        },
        signal,
      );
      return { events, counters: null };
    }
    const reference = recording.sealed;
    const object = await readRecordingObject(
      this.s3,
      this.bucket,
      reference.objectKey,
      reference.sha256,
      8 * 1024 * 1024,
      signal,
    );
    if (
      !record(object) ||
      object.schemaVersion !== 1 ||
      object.kind !== 'sealed_monitor_recording' ||
      object.sessionId !== session.view.id ||
      object.recorderGeneration !== Number(reference.objectKey.split('/')[3]) ||
      (object.recorderGeneration as number) > recording.generation ||
      object.startedAt !== session.view.readyAt ||
      object.cutoffAt !== session.view.endedAt ||
      object.source !== reference.source ||
      object.cursor !== reference.nextSequence ||
      !Array.isArray(object.frames) ||
      object.frames.length !== reference.frameCount ||
      !isMonitorMetricFrame(object.final) ||
      object.final.sample.at !== session.view.endedAt
    )
      throw new Error('Invalid sealed monitor evidence.');
    const events: DebriefMonitorEvent[] = [];
    let lastAt = session.view.readyAt!;
    for (const [index, raw] of object.frames.entries()) {
      if (
        !record(raw) ||
        raw.source !== reference.source ||
        raw.sequence !== index + 1 ||
        !isMonitorControlTimestamp(raw.recordedAt) ||
        raw.recordedAt < lastAt ||
        raw.recordedAt > session.view.endedAt! ||
        !isMonitorPayload(raw.payload)
      )
        throw new Error('Invalid monitor evidence frame.');
      lastAt = raw.recordedAt;
      const frame = raw as unknown as MonitorFrame;
      if (frame.payload.type === 'timeline') events.push(frame.payload.event);
    }
    return { events, counters: { ...object.final.counters } };
  }
  async read(session: SessionRecord, signal?: AbortSignal): Promise<RecordedEvidence> {
    const raw = await this.get(session.view.id, 'RECORDING', signal);
    if (
      !isMonitorRecordingState(raw, session.view.id) ||
      !['complete', 'incomplete'].includes(raw.status) ||
      raw.cutoffAt !== session.view.endedAt ||
      raw.status !== session.view.recording.status
    )
      throw new Error('Recording evidence is not sealed.');
    const commands = await this.commands(session, raw.status === 'complete', signal);
    const monitor = await this.monitor(session, raw, signal);
    return { commands, ...monitor };
  }
}
