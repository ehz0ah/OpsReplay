import { createHash, randomUUID } from 'node:crypto';
import { GetCommand, QueryCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { HeadObjectCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import {
  isTerminalRecordingCheckpoint,
  isStoredTerminalPage,
  encodeTerminalPage,
} from '../../contracts/private/terminal-persistence.js';
import {
  isTerminalSealState,
  isSealedTerminalPage,
  encodeSealedTerminalPage,
} from '../../contracts/private/terminal-sealing.js';
import {
  isMonitorRecordingState,
  isStoredMonitorChunkReference,
  type MonitorRecordingState,
} from '../../contracts/private/monitor-persistence.js';
import { isMonitorControlFrame } from '../../contracts/private/monitor-control.js';
import { isMonitorPayload, isMonitorMetricFrame, type MonitorFrame } from '../../../apps/gateway/src/monitor-client.js';
import {
  isSessionLifecycleState,
  lifecycleWorkItem,
  type SessionLifecycleState,
} from '../../contracts/private/session-lifecycle.js';
import { lifecycleHintItem } from '../../contracts/private/lifecycle-hint.js';
import { sendDynamoWrite } from '../../dynamodb/src/conflict-retry.js';
import { isMonitorFinalEvidence } from '../../contracts/private/monitor-final.js';
import { recordingRetention } from '../../contracts/private/recording-retention.js';
import {
  isPlaybackExportState,
  isPlaybackReference,
  playbackLimits,
  playbackObjectKey,
  type PlaybackExportState,
  type PlaybackReference,
} from '../../contracts/private/playback-persistence.js';
import { readRecordingObject } from './object-reader.js';
import { canonicalJson } from './canonical.js';
import { encodeAsciicast } from './asciicast.js';
import type { SessionRecord } from '../../../apps/api/src/start-session/types.js';
import { validSession, validSessionRelations } from '../../../apps/api/src/start-session/validation.js';
import type { TerminalRecordingEvent } from '../../contracts/private/terminal-recording.js';

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
import { playbackSourceHash } from './playback-source.js';
/** Export from fixed source snapshots after cleanup. No recorder or input lease.
 * Each pass does at most twenty source queries and saves forward-only progress. */
export class PlaybackExporter {
  constructor(
    private readonly dynamo: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly now = Date.now,
  ) {}
  private key(id: string, SK: string) {
    return { PK: `SESSION#${id}`, SK };
  }
  private async get(id: string, SK: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return (
      await this.dynamo.send(
        new GetCommand({ TableName: this.table, Key: this.key(id, SK), ConsistentRead: true }),
        signal ? { abortSignal: signal } : undefined,
      )
    ).Item?.data as unknown;
  }
  private async commit(
    id: string,
    recording: MonitorRecordingState,
    sources: Record<string, unknown>,
    previous: PlaybackExportState | undefined,
    next: PlaybackExportState,
    reference?: PlaybackReference,
    body?: Buffer,
    signal?: AbortSignal,
  ) {
    if (
      !isPlaybackExportState(next) ||
      (reference && (!body || !isPlaybackReference(reference, id) || body.length !== reference.byteLength))
    )
      throw new Error('Invalid export checkpoint.');
    signal?.throwIfAborted();
    if (reference && body) {
      const put = new PutObjectCommand({
        Bucket: this.bucket,
        Key: reference.objectKey,
        Body: body,
        ContentLength: body.length,
        ContentType: reference.kind === 'terminal' ? 'application/x-asciicast' : 'application/json; charset=utf-8',
        CacheControl: 'no-store',
        ServerSideEncryption: 'AES256',
        IfNoneMatch: '*',
        ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        Tagging: `${recordingRetention.tagKey}=${recording.status === 'complete' ? recordingRetention.sealedTagValue : recordingRetention.provisionalTagValue}`,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.s3.send(put, signal ? { abortSignal: signal } : undefined);
          break;
        } catch (error) {
          if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
            const head = await this.s3.send(
              new HeadObjectCommand({ Bucket: this.bucket, Key: reference.objectKey, ChecksumMode: 'ENABLED' }),
              signal ? { abortSignal: signal } : undefined,
            );
            if (
              head.ContentLength !== body.length ||
              head.ChecksumSHA256 !== createHash('sha256').update(body).digest('base64')
            )
              throw new Error('Export object conflict.');
            break;
          }
          if (attempt === 0 && error instanceof S3ServiceException && error.name === 'ConditionalRequestConflict')
            continue;
          throw error;
        }
      }
    }
    const SK = reference ? `PLAYBACK#${reference.kind}#${String(reference.nextSequence).padStart(6, '0')}` : undefined;
    const condition = (key: string, data: unknown) => ({
      ConditionCheck: {
        TableName: this.table,
        Key: this.key(id, key),
        ...(data === undefined
          ? { ConditionExpression: 'attribute_not_exists(PK)' }
          : {
              ConditionExpression: '#d = :v',
              ExpressionAttributeNames: { '#d': 'data' },
              ExpressionAttributeValues: { ':v': data },
            }),
      },
    });
    try {
      await sendDynamoWrite(
        this.dynamo,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            condition('RECORDING', recording),
            ...Object.entries(sources).map(([key, data]) =>
              next.complete && key === 'LIFECYCLE'
                ? {
                    Put: {
                      TableName: this.table,
                      Item: { ...this.key(id, key), data },
                      ConditionExpression: '#d = :v',
                      ExpressionAttributeNames: { '#d': 'data' },
                      ExpressionAttributeValues: { ':v': data },
                    },
                  }
                : condition(key, data),
            ),
            {
              Put: {
                TableName: this.table,
                Item: { ...this.key(id, 'PLAYBACK_EXPORT'), data: next },
                ConditionExpression: previous ? '#d = :p' : 'attribute_not_exists(PK)',
                ...(previous
                  ? { ExpressionAttributeNames: { '#d': 'data' }, ExpressionAttributeValues: { ':p': previous } }
                  : {}),
              },
            },
            ...(reference
              ? [
                  {
                    Put: {
                      TableName: this.table,
                      Item: { ...this.key(id, SK!), data: reference },
                      ConditionExpression: 'attribute_not_exists(PK)',
                    },
                  },
                ]
              : []),
          ],
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      return next;
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(id, 'PLAYBACK_EXPORT', signal);
      if (
        isPlaybackExportState(saved) &&
        saved.sourceSha256 === next.sourceSha256 &&
        (reference
          ? saved.terminalCursor >= next.terminalCursor &&
            saved.metricCursor >= next.metricCursor &&
            canonicalJson(await this.get(id, SK!, signal)) === canonicalJson(reference)
          : canonicalJson(saved) === canonicalJson(next))
      )
        return saved;
      throw error;
    }
  }
  /** One continuation hint per successful bounded pass, never per source page.
   * Discovery survives interruption and stale writers cannot reindex completed work. */
  private async continueWork(
    id: string,
    recording: MonitorRecordingState,
    sources: Record<string, unknown>,
    state: PlaybackExportState,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const lifecycle = sources.LIFECYCLE as SessionLifecycleState;
    const hint = lifecycleHintItem(id, 'playback', state.cutoffAt);
    try {
      await sendDynamoWrite(
        this.dynamo,
        new TransactWriteCommand({
          ClientRequestToken: randomUUID(),
          TransactItems: [
            ...[
              ['RECORDING', recording],
              ['PLAYBACK_EXPORT', state],
            ].map(([SK, data]) => ({
              ConditionCheck: {
                TableName: this.table,
                Key: this.key(id, SK as string),
                ConditionExpression: '#d = :v',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':v': data },
              },
            })),
            {
              Put: {
                TableName: this.table,
                Item: lifecycleWorkItem(lifecycle),
                ConditionExpression: '#d = :v',
                ExpressionAttributeNames: { '#d': 'data' },
                ExpressionAttributeValues: { ':v': lifecycle },
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  ...hint,
                  data: {
                    ...hint.data,
                    sourceSha256: state.sourceSha256,
                    terminalCursor: state.terminalCursor,
                    metricCursor: state.metricCursor,
                    metricScanKey: state.metricScanKey,
                  },
                },
              },
            },
          ],
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      return false;
    } catch (error) {
      if (signal?.aborted) throw error;
      const saved = await this.get(id, 'PLAYBACK_EXPORT', signal);
      if (isPlaybackExportState(saved) && saved.sourceSha256 === state.sourceSha256) {
        if (
          saved.terminalCursor > state.terminalCursor ||
          saved.metricCursor > state.metricCursor ||
          (saved.metricScanKey !== null &&
            (state.metricScanKey === null || saved.metricScanKey > state.metricScanKey)) ||
          saved.complete
        )
          return saved.complete;
        // A lost response can leave the exact hint and work index committed.
        const [receipt, work] = await Promise.all([
          this.get(id, hint.SK, signal),
          this.dynamo.send(
            new GetCommand({ TableName: this.table, Key: this.key(id, 'LIFECYCLE'), ConsistentRead: true }),
            signal ? { abortSignal: signal } : undefined,
          ),
        ]);
        const expected = {
          ...hint.data,
          sourceSha256: state.sourceSha256,
          terminalCursor: state.terminalCursor,
          metricCursor: state.metricCursor,
          metricScanKey: state.metricScanKey,
        };
        if (
          canonicalJson(saved) === canonicalJson(state) &&
          canonicalJson(receipt) === canonicalJson(expected) &&
          canonicalJson(work.Item) === canonicalJson(lifecycleWorkItem(lifecycle))
        )
          return false;
      }
      throw error;
    }
  }
  private reference(
    id: string,
    kind: PlaybackReference['kind'],
    source: string | null,
    after: number,
    nextSequence: number,
    body: Buffer,
    startedAt: string,
    endedAt: string,
  ): PlaybackReference {
    const data = {
      schemaVersion: 1 as const,
      kind,
      source,
      after,
      nextSequence,
      sha256: createHash('sha256').update(body).digest('hex'),
      byteLength: body.length,
      startedAt,
      endedAt,
    };
    return { ...data, objectKey: playbackObjectKey(id, data) };
  }
  async prepare(session: SessionRecord, signal?: AbortSignal): Promise<boolean> {
    if (!validSession(session) || !validSessionRelations(session) || !session.view.readyAt || !session.view.endedAt)
      throw new Error('Invalid playback session.');
    const id = session.view.id;
    const cutoff = session.view.endedAt;
    const recording = await this.get(id, 'RECORDING', signal);
    const lifecycle = await this.get(id, 'LIFECYCLE', signal);
    if (
      !isMonitorRecordingState(recording, id) ||
      !['complete', 'incomplete'].includes(recording.status) ||
      recording.cutoffAt !== cutoff ||
      recording.startedAt !== session.view.readyAt ||
      recording.status !== session.view.recording.status ||
      recording.reason !== session.view.recording.reason ||
      !isSessionLifecycleState(lifecycle, id) ||
      lifecycle.readyAt !== session.view.readyAt ||
      !lifecycle.taskStoppedAt ||
      lifecycle.taskStoppedAt < cutoff ||
      !lifecycle.schedulesDeleted
    )
      throw new Error('Playback recording or cleanup is not final.');
    const terminalKey = recording.status === 'complete' ? 'TERMINAL_SEAL' : 'TERMINAL_RECORDING';
    const terminal = await this.get(id, terminalKey, signal);
    if (
      recording.status === 'complete'
        ? !isTerminalSealState(terminal) || !terminal.complete || terminal.cutoffAt !== cutoff
        : terminal !== undefined && !isTerminalRecordingCheckpoint(terminal)
    )
      throw new Error('Invalid export terminal source.');
    const checkpoint = isTerminalSealState(terminal)
      ? terminal.checkpoint
      : isTerminalRecordingCheckpoint(terminal)
        ? terminal
        : undefined;
    if (
      checkpoint &&
      (checkpoint.metadata.source !== lifecycle.terminalSource || checkpoint.metadata.startedAt > cutoff)
    )
      throw new Error('Invalid terminal source identity.');
    const terminalCursor = isTerminalSealState(terminal) ? terminal.cursor : (checkpoint?.cursor ?? 0);
    const monitorFinal = recording.status === 'complete' ? await this.get(id, 'MONITOR_FINAL', signal) : undefined;
    if (
      monitorFinal !== undefined &&
      (!isMonitorFinalEvidence(monitorFinal) ||
        monitorFinal.cutoffAt !== cutoff ||
        monitorFinal.cursor !== recording.cursor ||
        monitorFinal.source !== recording.source)
    )
      throw new Error('Invalid final Monitor receipt.');
    const sources = {
      [terminalKey]: terminal,
      LIFECYCLE: lifecycle,
      ...(recording.status === 'complete' ? { MONITOR_FINAL: monitorFinal } : {}),
    };
    const sourceSha256 = playbackSourceHash(recording, terminal, lifecycle, monitorFinal);
    const saved = await this.get(id, 'PLAYBACK_EXPORT', signal);
    if (
      saved !== undefined &&
      (!isPlaybackExportState(saved) || saved.sourceSha256 !== sourceSha256 || saved.cutoffAt !== cutoff)
    )
      throw new Error('Invalid export state.');
    let state: PlaybackExportState = isPlaybackExportState(saved)
      ? saved
      : {
          schemaVersion: 1,
          cutoffAt: cutoff,
          sourceSha256,
          terminalCursor: 0,
          terminalBytes: 0,
          terminalCount: 0,
          terminalLastAt: null,
          columns: checkpoint?.metadata.initialColumns ?? 80,
          rows: checkpoint?.metadata.initialRows ?? 24,
          utf8Tail: '',
          inputTail: '',
          markerPrefix: '',
          markerDiscard: false,
          markerEscaped: false,
          terminalDone: terminalCursor === 0,
          metricCursor: 0,
          metricScanKey: null,
          metricBytes: 0,
          metricCount: 0,
          metricLastAt: null,
          metricsDone: recording.status === 'incomplete' && recording.cursor === 0,
          complete: terminalCursor === 0 && recording.status === 'incomplete' && recording.cursor === 0,
          unavailable: null,
        };
    if (this.now() >= Date.parse(recording.retainUntil!)) {
      // Expiry retires export work without reading retained objects.
      if (state.unavailable === 'expired')
        return (await this.commit(id, recording, sources, state, state, undefined, undefined, signal)).complete;
      return (
        await this.commit(
          id,
          recording,
          sources,
          isPlaybackExportState(saved) ? saved : undefined,
          {
            ...state,
            terminalDone: true,
            metricsDone: true,
            complete: true,
            unavailable: 'expired',
            utf8Tail: '',
            inputTail: '',
            markerPrefix: '',
            markerDiscard: false,
            markerEscaped: false,
          },
          undefined,
          undefined,
          signal,
        )
      ).complete;
    }
    if (saved === undefined)
      state = await this.commit(id, recording, sources, undefined, state, undefined, undefined, signal);
    if (state.terminalCursor > terminalCursor || state.metricCursor > recording.cursor)
      throw new Error('Export frontier exceeds source.');
    if (state.complete)
      return (await this.commit(id, recording, sources, state, state, undefined, undefined, signal)).complete;
    for (let page = 0; page < playbackLimits.maximumPagesPerPass && !state.complete; page++) {
      signal?.throwIfAborted();
      if (!state.terminalDone) {
        if (!checkpoint) throw new Error('Missing terminal source.');
        const prefix = `${recording.status === 'complete' ? 'TERMINAL_SEALED_CHUNK' : 'TERMINAL_CHUNK'}#${checkpoint.metadata.source}#`;
        const query = await this.dynamo.send(
          new QueryCommand({
            TableName: this.table,
            ConsistentRead: true,
            Limit: 1,
            KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
            ExpressionAttributeValues: {
              ':pk': `SESSION#${id}`,
              ':from': `${prefix}${String(state.terminalCursor + 1).padStart(6, '0')}`,
              ':to': `${prefix}999999`,
            },
          }),
          signal ? { abortSignal: signal } : undefined,
        );
        if (query.Items?.length !== 1) throw new Error('Missing terminal export page.');
        const row = query.Items[0]!;
        const ref: unknown = row.data;
        const generation = record(ref) && typeof ref.objectKey === 'string' ? Number(ref.objectKey.split('/')[3]) : NaN;
        if (
          !(recording.status === 'complete'
            ? isSealedTerminalPage(ref, id)
            : isStoredTerminalPage(ref, id, generation)) ||
          !record(ref) ||
          ref.source !== checkpoint.metadata.source ||
          ref.after !== state.terminalCursor ||
          (ref.nextSequence as number) > terminalCursor ||
          row.PK !== `SESSION#${id}` ||
          row.SK !== `${prefix}${String(ref.nextSequence).padStart(6, '0')}` ||
          (state.terminalLastAt !== null && (ref.firstAt as string) < state.terminalLastAt)
        )
          throw new Error('Invalid terminal export reference.');
        const object = await readRecordingObject(
          this.s3,
          this.bucket,
          ref.objectKey as string,
          ref.sha256 as string,
          ref.byteLength as number,
          signal,
        );
        let events: TerminalRecordingEvent[];
        if (recording.status === 'complete') {
          if (!record(object) || !Array.isArray(object.events)) throw new Error('Invalid sealed export page.');
          events = object.events as TerminalRecordingEvent[];
          const encoded = encodeSealedTerminalPage(
            id,
            generation,
            checkpoint.metadata.source,
            state.terminalCursor,
            events,
          );
          if (
            canonicalJson(encoded.reference) !== canonicalJson(ref) ||
            canonicalJson(object) !== encoded.body.toString() ||
            events.at(-1)!.recordedAt > cutoff
          )
            throw new Error('Invalid sealed export identity.');
        } else {
          if (!record(object) || !record(object.page)) throw new Error('Invalid partial export page.');
          const encoded = encodeTerminalPage(id, generation, state.terminalCursor, object.page as never);
          if (
            canonicalJson(encoded.reference) !== canonicalJson(ref) ||
            canonicalJson(object) !== encoded.body.toString()
          )
            throw new Error('Invalid partial export identity.');
          events = (object.page as unknown as { events: TerminalRecordingEvent[] }).events;
        }
        const accepted = events.filter((event) => event.recordedAt <= cutoff);
        const done = ref.nextSequence === terminalCursor || accepted.length !== events.length;
        const next = {
          ...state,
          terminalCursor: ref.nextSequence as number,
          terminalDone: done,
          complete: done && state.metricsDone,
        };
        if (accepted.length || (done && (state.utf8Tail || state.inputTail || state.markerPrefix))) {
          const cast = encodeAsciicast(state, accepted, done, state.terminalLastAt ?? undefined);
          Object.assign(next, cast.state, {
            terminalBytes: state.terminalBytes + cast.body.length,
            terminalCount: state.terminalCount + 1,
            terminalLastAt: cast.endedAt,
          });
          state = await this.commit(
            id,
            recording,
            sources,
            state,
            next,
            this.reference(
              id,
              'terminal',
              checkpoint.metadata.source,
              state.terminalCursor,
              next.terminalCursor,
              cast.body,
              cast.startedAt,
              cast.endedAt,
            ),
            cast.body,
            signal,
          );
        } else
          state = await this.commit(
            id,
            recording,
            sources,
            state,
            { ...next, markerDiscard: false, markerEscaped: false },
            undefined,
            undefined,
            signal,
          );
      } else {
        let actual: unknown = recording.sealed;
        let scanKey = state.metricScanKey;
        if (!recording.sealed) {
          const prefix = `CHUNK#${recording.source}#`;
          const query = await this.dynamo.send(
            new QueryCommand({
              TableName: this.table,
              ConsistentRead: true,
              Limit: 1,
              KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
              ExpressionAttributeValues: { ':pk': `SESSION#${id}`, ':p': prefix },
              ...(scanKey ? { ExclusiveStartKey: this.key(id, scanKey) } : {}),
            }),
            signal ? { abortSignal: signal } : undefined,
          );
          if (query.Items?.length !== 1) throw new Error('Missing metric export page.');
          const row = query.Items[0]!;
          if (
            row.PK !== `SESSION#${id}` ||
            typeof row.SK !== 'string' ||
            !row.SK.startsWith(prefix) ||
            (scanKey && row.SK <= scanKey) ||
            !record(row.data) ||
            row.data.schemaVersion !== 1 ||
            row.data.kind !== 'monitor_page'
          )
            throw new Error('Invalid metric export row.');
          scanKey = row.SK;
          actual = row.data.reference;
        }
        const generation =
          record(actual) && typeof actual.objectKey === 'string' ? Number(actual.objectKey.split('/')[3]) : NaN;
        if (
          !isStoredMonitorChunkReference(actual, id, generation, recording.sealed ? 'sealed' : 'live') ||
          actual.source !== recording.source ||
          actual.nextSequence > recording.cursor ||
          (!recording.sealed &&
            scanKey !==
              `CHUNK#${actual.source}#${String(generation).padStart(9, '0')}#${String(actual.nextSequence).padStart(6, '0')}`)
        )
          throw new Error('Invalid metric export reference.');
        if (actual.after < state.metricCursor && !recording.sealed) {
          if (actual.nextSequence > state.metricCursor) throw new Error('Overlapping metric export page.');
          state = await this.commit(
            id,
            recording,
            sources,
            state,
            { ...state, metricScanKey: scanKey },
            undefined,
            undefined,
            signal,
          );
          continue;
        }
        if (actual.after !== state.metricCursor) throw new Error('Metric export gap.');
        const object = await readRecordingObject(
          this.s3,
          this.bucket,
          actual.objectKey,
          actual.sha256,
          recording.sealed ? playbackLimits.maximumMetricObjectBytes : 128 * 1024,
          signal,
        );
        if (
          !record(object) ||
          object.schemaVersion !== 1 ||
          object.kind !== (recording.sealed ? 'sealed_monitor_recording' : 'monitor_page') ||
          object.sessionId !== id ||
          object.recorderGeneration !== generation ||
          object.startedAt !== session.view.readyAt ||
          object.source !== actual.source ||
          !Array.isArray(object.frames) ||
          object.frames.length !== actual.frameCount ||
          (recording.sealed
            ? object.cutoffAt !== cutoff ||
              object.cursor !== actual.nextSequence ||
              !isMonitorMetricFrame(object.final) ||
              object.final.sample.at !== cutoff
            : object.after !== actual.after || object.nextSequence !== actual.nextSequence)
        )
          throw new Error('Invalid metric export body.');
        if (
          recording.sealed &&
          monitorFinal !== undefined &&
          canonicalJson((monitorFinal as { final: unknown }).final) !== canonicalJson(object.final)
        )
          throw new Error('Final Monitor receipt differs from sealed object.');
        let lastAt = state.metricLastAt ?? session.view.readyAt;
        for (const [index, raw] of object.frames.entries()) {
          if (
            !isMonitorControlFrame(raw, isMonitorPayload) ||
            raw.source !== actual.source ||
            raw.sequence !== actual.after + index + 1 ||
            raw.recordedAt < lastAt
          )
            throw new Error('Invalid metric export frame.');
          const frame = raw as MonitorFrame;
          const payloadAt = frame.payload.type === 'metrics' ? frame.payload.sample.at : frame.payload.event.at;
          if (
            payloadAt > frame.recordedAt ||
            payloadAt < session.view.readyAt ||
            frame.recordedAt < session.view.readyAt ||
            (recording.sealed && frame.recordedAt > cutoff)
          )
            throw new Error('Invalid metric export time.');
          lastAt = frame.recordedAt;
        }
        const frames = object.frames.filter((raw) => (raw as MonitorFrame).recordedAt <= cutoff);
        const done = actual.nextSequence === recording.cursor || frames.length !== object.frames.length;
        const body = Buffer.from(
          canonicalJson({
            schemaVersion: 1,
            kind: 'playback_metrics',
            frames,
            ...(recording.sealed ? { final: object.final } : {}),
          }),
        );
        const startedAt = frames.length ? (frames[0] as MonitorFrame).recordedAt : session.view.readyAt;
        const endedAt = recording.sealed
          ? cutoff
          : frames.length
            ? (frames.at(-1) as MonitorFrame).recordedAt
            : startedAt;
        const next = {
          ...state,
          metricCursor: actual.nextSequence,
          metricScanKey: scanKey,
          metricsDone: done,
          complete: done,
        };
        if (frames.length || recording.sealed) {
          Object.assign(next, {
            metricBytes: state.metricBytes + body.length,
            metricCount: state.metricCount + 1,
            metricLastAt: endedAt,
          });
          state = await this.commit(
            id,
            recording,
            sources,
            state,
            next,
            this.reference(id, 'metrics', actual.source, actual.after, actual.nextSequence, body, startedAt, endedAt),
            body,
            signal,
          );
        } else state = await this.commit(id, recording, sources, state, next, undefined, undefined, signal);
      }
    }
    return state.complete || this.continueWork(id, recording, sources, state, signal);
  }
}
