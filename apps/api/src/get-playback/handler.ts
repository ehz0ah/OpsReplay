import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { readCommandPage } from '../../../../packages/session/src/command-reader.js';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isMonitorRecordingState } from '../../../../packages/contracts/private/monitor-persistence.js';
import { isTerminalSealState } from '../../../../packages/contracts/private/terminal-sealing.js';
import { isTerminalRecordingCheckpoint } from '../../../../packages/contracts/private/terminal-persistence.js';
import { playbackSourceHash } from '../../../../packages/session/src/playback-source.js';
import {
  isPlaybackExportState,
  isPlaybackReference,
  playbackLimits,
  type PlaybackReference,
} from '../../../../packages/contracts/private/playback-persistence.js';
import {
  isCaptureReference,
  isCaptureState,
  type CaptureReference,
} from '../../../../packages/contracts/private/capture-persistence.js';
import { captureLimits } from '../../../../packages/contracts/private/file-capture.js';
import {
  isCommandEvidence,
  isCommandParserCheckpoint,
} from '../../../../packages/contracts/private/command-evidence.js';
import { isPlaybackHighlights } from '../../../../packages/session/src/playback-highlights.js';
import { createResultReadAction, pageInput, ResultReadError, type ResultReader } from '../result-reads/shared.js';
import { decodePlaybackCursor, encodePlaybackCursor, snapshotCursor } from '../result-reads/cursor.js';

export interface PlaybackSigner {
  credentialExpiresAt(signal: AbortSignal): Promise<number | null>;
  sign(key: string, seconds: number, signingDate: Date, signal: AbortSignal): Promise<string>;
}
export function createS3PlaybackSigner(s3: S3Client, bucket: string): PlaybackSigner {
  let client: S3Client | undefined;
  return {
    credentialExpiresAt: async (signal) => {
      signal.throwIfAborted();
      const credentials = await s3.config.credentials();
      signal.throwIfAborted();
      // This signer is request-local. Its fixed credentials match the expiry
      // checked for this page, even if the provider refreshes during signing.
      client = new S3Client({
        region: s3.config.region,
        credentials,
        forcePathStyle: s3.config.forcePathStyle,
        endpointProvider: s3.config.endpointProvider,
      });
      return credentials.expiration?.getTime() ?? null;
    },
    sign: (key, seconds, signingDate, signal) => {
      signal.throwIfAborted();
      if (!client) throw new Error('Signing credentials not prepared.');
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: seconds,
        signingDate,
      });
    },
  };
}
export function createGetPlaybackHandler(
  store: ResultReader,
  s3: S3Client,
  bucket: string,
  providedSigner?: PlaybackSigner,
  now = Date.now,
  log?: Parameters<typeof createResultReadAction>[3],
) {
  return createResultReadAction(
    'get_playback',
    '/v1/sessions/{id}/playback',
    async ({ id, owner, signal, event }) => {
      const signer = providedSigner ?? createS3PlaybackSigner(s3, bucket);
      const input = pageInput(event, playbackLimits.maximumLinksPerPage);
      const session = await store.owned(id, owner, signal);
      await store.debrief(session, signal);
      const recording = await store.get(id, 'RECORDING', signal);
      if (
        !isMonitorRecordingState(recording, id) ||
        recording.cutoffAt !== session.view.endedAt ||
        recording.status !== session.view.recording.status ||
        recording.reason !== session.view.recording.reason
      )
        throw new Error('Invalid playback recording.');
      const retention = Date.parse(recording.retainUntil!);
      if (now() >= retention) throw new ResultReadError('RECORDING_EXPIRED');
      const exportState = await store.get(id, 'PLAYBACK_EXPORT', signal);
      if (exportState === undefined) throw new ResultReadError('PLAYBACK_PENDING');
      if (!isPlaybackExportState(exportState) || exportState.cutoffAt !== session.view.endedAt)
        throw new Error('Invalid playback export state.');
      if (!exportState.complete) throw new ResultReadError('PLAYBACK_PENDING');
      if (exportState.unavailable !== null) throw new Error('Playback export is unavailable.');
      const terminalSource = await store.get(
        id,
        recording.status === 'complete' ? 'TERMINAL_SEAL' : 'TERMINAL_RECORDING',
        signal,
      );
      const lifecycle = await store.get(id, 'LIFECYCLE', signal);
      const monitorFinal = recording.status === 'complete' ? await store.get(id, 'MONITOR_FINAL', signal) : undefined;
      if (exportState.sourceSha256 !== playbackSourceHash(recording, terminalSource, lifecycle, monitorFinal))
        throw new Error('Playback source snapshot changed.');
      const terminalId = isTerminalSealState(terminalSource)
        ? terminalSource.checkpoint.metadata.source
        : isTerminalRecordingCheckpoint(terminalSource)
          ? terminalSource.metadata.source
          : null;
      const capturesState = await store.get(id, 'CAPTURE_STATE', signal);
      if (capturesState !== undefined && !isCaptureState(capturesState)) throw new Error('Invalid capture state.');
      const snapshot = snapshotCursor({
        cutoff: recording.cutoffAt,
        exportState,
        capturesState: capturesState ?? null,
      });
      let position = decodePlaybackCursor(input.cursor, id, snapshot);
      const selected: (PlaybackReference | CaptureReference)[] = [];
      const prefixes = ['PLAYBACK#metrics#', 'PLAYBACK#terminal#', 'CAPTURE#'];
      let scanned = 0;
      // Keyset paging reads at most 25 rows and three range transitions, not the
      // whole recording. Immutable receipts and checkpoints fix this snapshot.
      for (let queryCount = 0; position.phase < 3 && scanned < input.limit && queryCount < 28; queryCount++) {
        const prefix = prefixes[position.phase]!;
        const result = await store.client.send(
          new QueryCommand({
            TableName: store.table,
            ConsistentRead: true,
            Limit: input.limit - scanned,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
            ExpressionAttributeValues: { ':pk': `SESSION#${id}`, ':p': prefix },
            ...(position.key ? { ExclusiveStartKey: { PK: `SESSION#${id}`, SK: position.key } } : {}),
          }),
          { abortSignal: signal },
        );
        scanned += result.Items?.length ?? 0;
        position.count += result.Items?.length ?? 0;
        if (scanned > input.limit) throw new Error('Playback page bound exceeded.');
        let previous = position.key;
        let expectedAfter = position.key ? Number(position.key.slice(-6)) : 0;
        if (
          position.phase < 2 &&
          !position.key &&
          !result.Items?.length &&
          (position.phase === 0 ? exportState.metricCount : exportState.terminalCount) > 0
        )
          throw new Error('Missing playback references.');
        for (const row of result.Items ?? []) {
          const data: unknown = row.data;
          if (position.phase < 2 ? !isPlaybackReference(data, id) : !isCaptureReference(data, id))
            throw new Error('Invalid playback reference.');
          const ref = data as PlaybackReference | CaptureReference;
          const key =
            'kind' in ref
              ? `PLAYBACK#${ref.kind}#${String(ref.nextSequence).padStart(6, '0')}`
              : `CAPTURE#${String(ref.commandSeq).padStart(6, '0')}`;
          if (row.PK !== `SESSION#${id}` || row.SK !== key || !key.startsWith(prefix) || (previous && key <= previous))
            throw new Error('Invalid playback row.');
          previous = key;
          if ('kind' in ref) {
            const frontier = ref.kind === 'terminal' ? exportState.terminalCursor : exportState.metricCursor;
            const bytes = ref.kind === 'terminal' ? exportState.terminalBytes : exportState.metricBytes;
            const source = ref.kind === 'terminal' ? terminalId : recording.source;
            if (
              ref.source !== source ||
              ref.after !== expectedAfter ||
              ref.nextSequence > frontier ||
              ref.byteLength > bytes ||
              ref.endedAt > session.view.endedAt!
            )
              throw new Error('Playback receipt mismatch.');
            expectedAfter = ref.nextSequence;
          } else {
            if (
              !isCaptureState(capturesState) ||
              ref.sequence > capturesState.sequence ||
              ref.byteLength > captureLimits.maximumRetainedBytes
            )
              throw new Error('Capture receipt mismatch.');
            const complete = recording.status === 'complete';
            const command = (
              await readCommandPage(
                store.client,
                store.table,
                id,
                complete ? 'SEALED_COMMAND' : 'COMMAND',
                ref.commandSeq - 1,
                ref.commandSeq,
                signal,
              )
            )[0];
            const parser =
              command === undefined
                ? await store.get(id, complete ? 'SEALED_COMMAND_PARSER' : 'COMMAND_PARSER', signal)
                : undefined;
            const observed = command ?? (isCommandParserCheckpoint(parser) ? parser.active?.event : undefined);
            if (!isCommandEvidence(observed) || observed.id !== ref.commandId || observed.seq !== ref.commandSeq)
              throw new Error('Capture command receipt mismatch.');
            if (observed.at < session.view.readyAt! || observed.at > session.view.endedAt!) continue;
          }
          selected.push(ref);
        }
        if (result.LastEvaluatedKey) {
          const key = result.LastEvaluatedKey;
          if (
            key.PK !== `SESSION#${id}` ||
            typeof key.SK !== 'string' ||
            !key.SK.startsWith(prefix) ||
            key.SK !== previous ||
            key.SK === position.key
          )
            throw new Error('Invalid playback pagination.');
          position = { phase: position.phase, key: key.SK, count: position.count };
        } else {
          const count =
            position.phase === 0
              ? exportState.metricCount
              : position.phase === 1
                ? exportState.terminalCount
                : isCaptureState(capturesState)
                  ? capturesState.sequence
                  : 0;
          if (position.count !== count) throw new Error('Playback receipt count mismatch.');
          position = { phase: position.phase + 1, key: null, count: 0 };
        }
      }
      const terminal: { url: string; startedAt: string; endedAt: string }[] = [];
      const metrics: typeof terminal = [];
      const captures: {
        commandSeq: number;
        url: string;
        baselineAt: string;
        startedAt: string;
        completedAt: string;
      }[] = [];
      const highlights = await store.get(id, 'PLAYBACK_HIGHLIGHTS', signal);
      if (!isPlaybackHighlights(highlights)) throw new Error('Invalid playback highlights.');
      // Inspect all selected immutable objects before creating any URL.
      for (const ref of selected) {
        signal.throwIfAborted();
        const head = await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: ref.objectKey, ChecksumMode: 'ENABLED' }),
          { abortSignal: signal },
        );
        if (
          head.ContentLength !== ref.byteLength ||
          head.ChecksumSHA256 !== Buffer.from(ref.sha256, 'hex').toString('base64')
        )
          throw new Error('Playback object unavailable.');
      }
      signal.throwIfAborted();
      const credentialExpiry = await signer.credentialExpiresAt(signal);
      const signingDate = new Date(Math.floor(now() / 1000) * 1000);
      const expiresMs = Math.min(
        signingDate.getTime() + playbackLimits.linkSeconds * 1000,
        retention,
        credentialExpiry ?? Infinity,
      );
      const seconds = Math.floor((expiresMs - signingDate.getTime()) / 1000);
      const expiresAt = signingDate.getTime() + seconds * 1000;
      if (seconds < 1 || now() >= expiresAt) {
        if (now() >= retention) throw new ResultReadError('RECORDING_EXPIRED');
        throw new Error('Signing credentials expired.');
      }
      for (const ref of selected) {
        signal.throwIfAborted();
        if (now() >= expiresAt) throw new Error('Playback signing deadline exceeded.');
        const url = await signer.sign(ref.objectKey, seconds, signingDate, signal);
        if (url.length > 2000 || !url.startsWith('https://')) throw new Error('Invalid playback URL.');
        if ('kind' in ref)
          (ref.kind === 'terminal' ? terminal : metrics).push({ url, startedAt: ref.startedAt, endedAt: ref.endedAt });
        else
          captures.push({
            commandSeq: ref.commandSeq,
            url,
            baselineAt: ref.baselineAt,
            startedAt: ref.startedAt,
            completedAt: ref.completedAt,
          });
      }
      if (now() >= expiresAt) throw new Error('Playback signing deadline exceeded.');
      return {
        sessionId: id,
        expiresAt: new Date(expiresAt).toISOString(),
        terminal,
        metrics,
        captures,
        highlights,
        recording: session.view.recording,
        nextCursor: position.phase < 3 ? encodePlaybackCursor(id, snapshot, position) : null,
      };
    },
    log,
  );
}
