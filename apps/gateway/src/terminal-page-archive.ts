import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import {
  encodeTerminalPage,
  isStoredTerminalPage,
  type StoredTerminalPage,
} from '../../../packages/contracts/private/terminal-persistence.js';
import {
  encodeSealedTerminalPage,
  type SealedTerminalPage,
} from '../../../packages/contracts/private/terminal-sealing.js';
import { recordingRetention } from '../../../packages/contracts/private/recording-retention.js';
import type {
  TerminalRecordingEvent,
  TerminalRecordingPage,
} from '../../../packages/contracts/private/terminal-recording.js';
import { TerminalRecordingStoreError } from './terminal-recording-store.js';

export interface TerminalPageArchive {
  readLive(sessionId: string, reference: StoredTerminalPage, signal?: AbortSignal): Promise<TerminalRecordingPage>;
  putSealed(
    sessionId: string,
    generation: number,
    source: string,
    after: number,
    events: readonly TerminalRecordingEvent[],
    signal?: AbortSignal,
  ): Promise<SealedTerminalPage>;
}

/** Reads one bounded committed page at a time. Never accumulates the whole recording. */
export class S3TerminalPageArchive implements TerminalPageArchive {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    if (!/^(?=.{3,63}$)(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket))
      throw new TerminalRecordingStoreError('invalid_config');
  }
  async readLive(
    sessionId: string,
    reference: StoredTerminalPage,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingPage> {
    const generation = Number(reference.objectKey.split('/')[3]);
    if (!isStoredTerminalPage(reference, sessionId, generation)) throw new TerminalRecordingStoreError('invalid_input');
    reference = { ...reference };
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(7_000)]);
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: reference.objectKey, ChecksumMode: 'ENABLED' }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (error instanceof S3ServiceException && error.name === 'NoSuchKey')
        throw new TerminalRecordingStoreError('invalid_store');
      throw error;
    }
    const body = result.Body;
    if (!(body instanceof Readable)) throw new TerminalRecordingStoreError('invalid_store');
    if (result.ContentLength !== reference.byteLength) {
      body.destroy();
      throw new TerminalRecordingStoreError('invalid_store');
    }
    const cancel = () =>
      body.destroy(Object.assign(new Error('Terminal archive read cancelled.'), { name: 'AbortError' }));
    signal?.addEventListener('abort', cancel, { once: true });
    const pieces: Buffer[] = [];
    let length = 0;
    try {
      signal?.throwIfAborted();
      for await (const part of body) {
        signal?.throwIfAborted();
        const bytes = Buffer.from(part as Uint8Array);
        length += bytes.byteLength;
        if (length > reference.byteLength) throw new TerminalRecordingStoreError('invalid_store');
        pieces.push(bytes);
      }
      signal?.throwIfAborted();
      const bytes = Buffer.concat(pieces, length);
      if (length !== reference.byteLength || createHash('sha256').update(bytes).digest('hex') !== reference.sha256)
        throw new TerminalRecordingStoreError('invalid_store');
      const envelope = JSON.parse(bytes.toString('utf8')) as { page: TerminalRecordingPage };
      const expected = encodeTerminalPage(sessionId, generation, reference.after, envelope.page);
      if (
        !bytes.equals(expected.body) ||
        Object.keys(expected.reference).some(
          (key) => expected.reference[key as keyof StoredTerminalPage] !== reference[key as keyof StoredTerminalPage],
        )
      )
        throw new TerminalRecordingStoreError('invalid_store');
      return structuredClone(envelope.page);
    } catch (error) {
      body.destroy();
      if (signal?.aborted || error instanceof TerminalRecordingStoreError) throw error;
      if (
        error instanceof SyntaxError ||
        error instanceof TypeError ||
        (error instanceof Error && error.message === 'Invalid terminal recording page.')
      )
        throw new TerminalRecordingStoreError('invalid_store');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  async putSealed(
    sessionId: string,
    generation: number,
    source: string,
    after: number,
    events: readonly TerminalRecordingEvent[],
    signal?: AbortSignal,
  ): Promise<SealedTerminalPage> {
    let encoded;
    try {
      encoded = encodeSealedTerminalPage(sessionId, generation, source, after, events);
    } catch {
      throw new TerminalRecordingStoreError('invalid_input');
    }
    const { body, reference } = encoded;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: reference.objectKey,
      Body: body,
      ContentLength: body.byteLength,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-store',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
      IfNoneMatch: '*',
      Tagging: `${recordingRetention.tagKey}=${recordingRetention.sealedTagValue}`,
      Metadata: { schema: '1', sha256: reference.sha256, phase: 'sealed' },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.client.send(command, signal === undefined ? undefined : { abortSignal: signal });
        return reference;
      } catch (error) {
        if (error instanceof S3ServiceException) {
          if (error.$metadata.httpStatusCode === 412) return reference;
          if (attempt === 0 && error.name === 'ConditionalRequestConflict' && error.$metadata.httpStatusCode === 409)
            continue;
        }
        throw error;
      }
    }
    throw new TerminalRecordingStoreError('invalid_store');
  }
}
