import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

/** Private object reads require a saved hash, a byte bound, and a deadline. */
export async function readRecordingObject(
  client: S3Client,
  bucket: string,
  key: string,
  sha256: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 8 * 1024 * 1024
  )
    throw new Error('Invalid recording reference.');
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(7000)]);
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }), {
    abortSignal: bounded,
  });
  const body = result.Body;
  if (!(body instanceof Readable)) throw new Error('Invalid recording body.');
  const cancel = () => body.destroy(Object.assign(new Error('Recording read cancelled.'), { name: 'AbortError' }));
  bounded.addEventListener('abort', cancel, { once: true });
  const pieces: Buffer[] = [];
  let length = 0;
  try {
    bounded.throwIfAborted();
    if (
      !Number.isSafeInteger(result.ContentLength) ||
      result.ContentLength! < 1 ||
      result.ContentLength! > maximumBytes
    )
      throw new Error('Invalid recording length.');
    for await (const part of body) {
      bounded.throwIfAborted();
      const bytes = Buffer.from(part as Uint8Array);
      length += bytes.length;
      if (length > maximumBytes) throw new Error('Recording limit exceeded.');
      pieces.push(bytes);
    }
    bounded.throwIfAborted();
    const bytes = Buffer.concat(pieces, length);
    if (length !== result.ContentLength || createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('Recording integrity check failed.');
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    body.destroy();
    throw error;
  } finally {
    bounded.removeEventListener('abort', cancel);
  }
}
