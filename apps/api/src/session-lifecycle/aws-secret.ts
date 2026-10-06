import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { SessionRecord } from '../start-session/types.js';
import type { MonitorSecretPort } from './ports.js';
import { createAwsTransport, sendOptions } from '../shared/aws.js';

export class MonitorSecretFile implements MonitorSecretPort {
  constructor(private readonly client: S3Client) {}

  async ensure(session: SessionRecord, abortSignal?: AbortSignal): Promise<void> {
    const reference = session.launchArguments.overrides.containerOverrides[0].environmentFiles[0].value;
    const match = /^arn:aws[a-z-]*:s3:::([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/(sessions\/[a-f0-9-]{36}\.env)$/.exec(reference);
    if (!match || match[2] !== `sessions/${session.view.id}.env`
      || !/^[A-Za-z0-9_-]{43}$/.test(session.monitorSecret)) throw new Error('Invalid monitor secret file');
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: match[1]!, Key: match[2]!,
        Body: `OPSREPLAY_MONITOR_SECRET=${session.monitorSecret}\n`,
        ContentType: 'text/plain; charset=utf-8',
        ServerSideEncryption: 'AES256',
        // The saved session is immutable. Concurrent starts reuse the same object.
        IfNoneMatch: '*',
      }), sendOptions(abortSignal));
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) return;
      throw error;
    }
  }
}

export function createS3Client() {
  return new S3Client({ maxAttempts: 2, requestHandler: createAwsTransport() });
}
