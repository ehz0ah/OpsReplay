import { createHash } from 'node:crypto';
import { PutObjectCommand, S3ServiceException } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  isMonitorControlSource,
  isMonitorControlTimestamp,
  monitorControlSchema,
} from '../../../packages/contracts/private/monitor-control.js';
import { isMonitorMetricFrame, isMonitorPayload } from './monitor-client.js';
import { monitorRecordingLimits, type MonitorRecordingBatch, type SealedMonitorRecording } from './monitor-recorder.js';

export interface StoredMonitorChunk {
  phase: 'live' | 'sealed';
  objectKey: string;
  sha256: string;
  source: string | null;
  after: number;
  nextSequence: number;
  frameCount: number;
}

export interface MonitorChunkStore {
  putLive(
    sessionId: string,
    generation: number,
    value: MonitorRecordingBatch,
    signal?: AbortSignal,
  ): Promise<StoredMonitorChunk>;
  putSealed(
    sessionId: string,
    generation: number,
    value: SealedMonitorRecording,
    signal?: AbortSignal,
  ): Promise<StoredMonitorChunk>;
}

export type MonitorChunkStoreErrorCode = 'invalid_config' | 'invalid_chunk' | 'chunk_too_large';

const messages: Record<MonitorChunkStoreErrorCode, string> = {
  invalid_config: 'Monitor chunk store configuration is invalid.',
  invalid_chunk: 'Monitor recording chunk is invalid.',
  chunk_too_large: 'Monitor recording chunk is too large.',
};

export class MonitorChunkStoreError extends Error {
  constructor(readonly code: MonitorChunkStoreErrorCode) {
    super(messages[code]);
    this.name = 'MonitorChunkStoreError';
  }
}

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const bucketPattern = /^(?=.{3,63}$)(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const maximumGeneration = 999_999_999;
const maximumLiveBytes = 128 * 1024;
const maximumSealedBytes = 8 * 1024 * 1024;

function validIdentity(sessionId: string, generation: number): boolean {
  return (
    sessionIdPattern.test(sessionId) &&
    Number.isInteger(generation) &&
    generation >= 1 &&
    generation <= maximumGeneration
  );
}

function validFrames(
  frames: MonitorRecordingBatch['frames'],
  source: string,
  after: number,
  nextSequence: number,
  maximumFrames: number,
): boolean {
  if (
    !isMonitorControlSource(source) ||
    !Number.isInteger(after) ||
    after < 0 ||
    !Number.isInteger(nextSequence) ||
    nextSequence <= after ||
    nextSequence > monitorControlSchema.maximumCursor ||
    frames.length < 1 ||
    frames.length > maximumFrames ||
    nextSequence - after !== frames.length
  ) {
    return false;
  }
  return frames.every(
    (frame, index) =>
      frame.source === source &&
      frame.sequence === after + index + 1 &&
      isMonitorControlTimestamp(frame.recordedAt) &&
      isMonitorPayload(frame.payload),
  );
}

function validLive(value: MonitorRecordingBatch): boolean {
  return (
    isMonitorControlTimestamp(value.startedAt) &&
    validFrames(
      value.frames,
      value.source,
      value.after,
      value.nextSequence,
      monitorControlSchema.maximumFramesPerPage,
    ) &&
    value.frames.every((frame) => Date.parse(frame.recordedAt) >= Date.parse(value.startedAt))
  );
}

function validSealed(value: SealedMonitorRecording): boolean {
  if (
    !isMonitorControlTimestamp(value.startedAt) ||
    !isMonitorControlTimestamp(value.cutoffAt) ||
    Date.parse(value.cutoffAt) < Date.parse(value.startedAt) ||
    !isMonitorMetricFrame(value.final) ||
    value.final.sample.at !== value.cutoffAt ||
    !Number.isInteger(value.cursor) ||
    value.cursor < 0 ||
    value.cursor > monitorRecordingLimits.maximumFrames
  ) {
    return false;
  }
  if (value.cursor === 0) return value.source === null && value.frames.length === 0;
  if (value.source === null || value.frames.length !== value.cursor) return false;
  return (
    validFrames(value.frames, value.source, 0, value.cursor, monitorRecordingLimits.maximumFrames) &&
    value.frames.every((frame) => {
      const recordedAt = Date.parse(frame.recordedAt);
      return recordedAt >= Date.parse(value.startedAt) && recordedAt <= Date.parse(value.cutoffAt);
    })
  );
}

function segment(value: number, width = 6): string {
  return String(value).padStart(width, '0');
}

interface EncodedChunk {
  body: Buffer;
  reference: StoredMonitorChunk;
  checksum: string;
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  }
  return value;
}

function encode(
  bucket: string,
  sessionId: string,
  generation: number,
  phase: StoredMonitorChunk['phase'],
  source: string | null,
  after: number,
  nextSequence: number,
  frameCount: number,
  value: object,
): EncodedChunk {
  const body = Buffer.from(JSON.stringify(value, sortObjectKeys));
  const digest = createHash('sha256').update(body).digest();
  const sha256 = digest.toString('hex');
  const sourceSegment = source ?? 'empty';
  const objectKey = [
    'sessions',
    sessionId,
    'metrics',
    segment(generation, 9),
    phase,
    sourceSegment,
    `${segment(after + (frameCount === 0 ? 0 : 1))}-${segment(nextSequence)}-${sha256}.json`,
  ].join('/');
  if (!bucketPattern.test(bucket) || objectKey.length > 1_024) throw new MonitorChunkStoreError('invalid_config');
  return {
    body,
    checksum: digest.toString('base64'),
    reference: { phase, objectKey, sha256, source, after, nextSequence, frameCount },
  };
}

export class S3MonitorChunkStore implements MonitorChunkStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    if (!bucketPattern.test(bucket)) throw new MonitorChunkStoreError('invalid_config');
  }

  async putLive(
    sessionId: string,
    generation: number,
    value: MonitorRecordingBatch,
    signal?: AbortSignal,
  ): Promise<StoredMonitorChunk> {
    if (!validIdentity(sessionId, generation) || !validLive(value)) throw new MonitorChunkStoreError('invalid_chunk');
    const encoded = encode(
      this.bucket,
      sessionId,
      generation,
      'live',
      value.source,
      value.after,
      value.nextSequence,
      value.frames.length,
      {
        schemaVersion: 1,
        kind: 'monitor_page',
        sessionId,
        recorderGeneration: generation,
        ...value,
      },
    );
    await this.put(encoded, maximumLiveBytes, signal);
    return { ...encoded.reference };
  }

  async putSealed(
    sessionId: string,
    generation: number,
    value: SealedMonitorRecording,
    signal?: AbortSignal,
  ): Promise<StoredMonitorChunk> {
    if (!validIdentity(sessionId, generation) || !validSealed(value)) {
      throw new MonitorChunkStoreError('invalid_chunk');
    }
    const encoded = encode(
      this.bucket,
      sessionId,
      generation,
      'sealed',
      value.source,
      0,
      value.cursor,
      value.frames.length,
      {
        schemaVersion: 1,
        kind: 'sealed_monitor_recording',
        sessionId,
        recorderGeneration: generation,
        ...value,
      },
    );
    await this.put(encoded, maximumSealedBytes, signal);
    return { ...encoded.reference };
  }

  private async put(encoded: EncodedChunk, maximumBytes: number, signal?: AbortSignal): Promise<void> {
    if (encoded.body.byteLength > maximumBytes) throw new MonitorChunkStoreError('chunk_too_large');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: encoded.reference.objectKey,
      Body: encoded.body,
      ContentLength: encoded.body.byteLength,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-store',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: encoded.checksum,
      IfNoneMatch: '*',
      Metadata: {
        schema: '1',
        phase: encoded.reference.phase,
        sha256: encoded.reference.sha256,
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.client.send(command, signal === undefined ? undefined : { abortSignal: signal });
        return;
      } catch (error) {
        if (error instanceof S3ServiceException) {
          if (error.$metadata.httpStatusCode === 412) return;
          if (attempt === 0 && error.$metadata.httpStatusCode === 409 && error.name === 'ConditionalRequestConflict') {
            continue;
          }
        }
        throw error;
      }
    }
  }
}
