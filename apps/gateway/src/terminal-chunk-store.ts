import { createHash } from 'node:crypto';
import { PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { recordingRetention } from '../../../packages/contracts/private/recording-retention.js';
import {
  isTerminalRecordingPage,
  type TerminalRecordingPage,
} from '../../../packages/contracts/private/terminal-recording.js';
import {
  encodeTerminalPage,
  type StoredTerminalPage,
} from '../../../packages/contracts/private/terminal-persistence.js';
import { isMonitorRecordingIdentity } from './monitor-recording-identity.js';

export interface TerminalChunkStore {
  putPage(
    sessionId: string,
    generation: number,
    after: number,
    page: TerminalRecordingPage,
    signal?: AbortSignal,
  ): Promise<StoredTerminalPage>;
}
export class TerminalChunkStoreError extends Error {
  constructor(readonly code: 'invalid_config' | 'invalid_page') {
    super('Terminal recording page storage failed.');
    this.name = 'TerminalChunkStoreError';
  }
}

const bucketPattern = /^(?=.{3,63}$)(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

/** Byte-preserving private pages. Asciicast is a later derived playback format. */
export class S3TerminalChunkStore implements TerminalChunkStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    if (!bucketPattern.test(bucket)) throw new TerminalChunkStoreError('invalid_config');
  }

  async putPage(
    sessionId: string,
    generation: number,
    after: number,
    page: TerminalRecordingPage,
    signal?: AbortSignal,
  ): Promise<StoredTerminalPage> {
    if (
      !isMonitorRecordingIdentity(sessionId, generation) ||
      !isTerminalRecordingPage(page, page.source, after) ||
      page.events.length === 0
    ) {
      throw new TerminalChunkStoreError('invalid_page');
    }
    const { body, reference } = encodeTerminalPage(sessionId, generation, after, page);
    const digest = createHash('sha256').update(body).digest();
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: reference.objectKey,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-store',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: digest.toString('base64'),
      IfNoneMatch: '*',
      Tagging: `${recordingRetention.tagKey}=${recordingRetention.provisionalTagValue}`,
      Metadata: { schema: '1', sha256: reference.sha256, phase: 'live' },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.client.send(command, signal === undefined ? undefined : { abortSignal: signal });
        return reference;
      } catch (error) {
        if (error instanceof S3ServiceException) {
          if (error.$metadata.httpStatusCode === 412) return reference;
          if (attempt === 0 && error.$metadata.httpStatusCode === 409 && error.name === 'ConditionalRequestConflict')
            continue;
        }
        throw error;
      }
    }
    throw new TerminalChunkStoreError('invalid_page');
  }
}
