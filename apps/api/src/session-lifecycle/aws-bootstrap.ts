import { GetObjectTaggingCommand, PutObjectCommand, S3Client, S3ServiceException, type Tag } from '@aws-sdk/client-s3';
import type { SessionRecord } from '../start-session/types.js';
import type { MonitorBootstrapPort } from './ports.js';
import { createAwsTransport, sendOptions } from '../shared/aws.js';
import {
  validateMonitorCertificatePair,
  validMonitorCertificate,
  type MonitorCertificatePair,
} from './monitor-certificate-validation.js';
import { createMonitorCertificate } from './monitor-certificate.js';

const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const certificatePartCountTag = 'opsreplay-certificate-parts';
const certificatePartTagPrefix = 'opsreplay-certificate-';
const maximumCertificateTagParts = 8;
const maximumTagValueCharacters = 256;

interface BootstrapLocation {
  bucket: string;
  key: string;
}

type CertificateFactory = (session: SessionRecord) => Promise<MonitorCertificatePair>;

function location(session: SessionRecord): BootstrapLocation {
  const reference = session.launchArguments.overrides.containerOverrides[0].environmentFiles[0].value;
  const match = /^arn:aws[a-z-]*:s3:::([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\/(sessions\/[a-f0-9-]{36}\.env)$/.exec(
    reference,
  );
  if (!match || match[2] !== `sessions/${session.view.id}.env` || !secretPattern.test(session.monitorSecret)) {
    throw new Error('Invalid monitor bootstrap file');
  }
  return { bucket: match[1]!, key: match[2]! };
}

function encode(session: SessionRecord, pair: MonitorCertificatePair): string {
  return [
    `OPSREPLAY_MONITOR_SECRET=${session.monitorSecret}`,
    `OPSREPLAY_MONITOR_TLS_CERT_B64=${Buffer.from(pair.certificate).toString('base64')}`,
    `OPSREPLAY_MONITOR_TLS_KEY_B64=${Buffer.from(pair.privateKey).toString('base64')}`,
    '',
  ].join('\n');
}

function encodeCertificateTags(certificate: string): string {
  const encoded = Buffer.from(certificate).toString('base64url');
  const parts = encoded.match(new RegExp(`.{1,${maximumTagValueCharacters}}`, 'g')) ?? [];
  if (parts.length === 0 || parts.length > maximumCertificateTagParts) {
    throw new Error('Monitor certificate does not fit bootstrap tags');
  }
  const tags = new URLSearchParams([[certificatePartCountTag, String(parts.length)]]);
  for (const [index, part] of parts.entries()) tags.set(`${certificatePartTagPrefix}${index}`, part);
  return tags.toString();
}

function decodeCertificateTags(session: SessionRecord, tagSet: Tag[] | undefined): string {
  try {
    const tags = new Map<string, string>();
    for (const tag of tagSet ?? []) {
      if (typeof tag.Key !== 'string' || typeof tag.Value !== 'string' || tags.has(tag.Key)) {
        throw new Error('Invalid stored monitor certificate tags');
      }
      tags.set(tag.Key, tag.Value);
    }
    const countText = tags.get(certificatePartCountTag);
    if (!countText || !/^[1-9][0-9]*$/.test(countText)) throw new Error('Invalid stored monitor certificate tags');
    const count = Number(countText);
    if (count > maximumCertificateTagParts) throw new Error('Invalid stored monitor certificate tags');
    const parts: string[] = [];
    for (let index = 0; index < count; index++) {
      const part = tags.get(`${certificatePartTagPrefix}${index}`);
      if (!part || part.length > maximumTagValueCharacters || !/^[A-Za-z0-9_-]+$/.test(part)) {
        throw new Error('Invalid stored monitor certificate tags');
      }
      parts.push(part);
    }
    const encoded = parts.join('');
    if (Buffer.from(encoded, 'base64url').toString('base64url') !== encoded) {
      throw new Error('Invalid stored monitor certificate tags');
    }
    const certificate = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!validMonitorCertificate(session, certificate)) throw new Error('Invalid stored monitor certificate tags');
    return certificate;
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid stored monitor certificate tags') throw error;
    throw new Error('Invalid stored monitor certificate tags', { cause: error });
  }
}

function isConflict(error: unknown, status: number, name: string): boolean {
  return error instanceof S3ServiceException && error.$metadata.httpStatusCode === status && error.name === name;
}

function canHaveCommitted(error: unknown): boolean {
  return (
    !(error instanceof S3ServiceException) ||
    error.$metadata.httpStatusCode === undefined ||
    error.$metadata.httpStatusCode >= 500
  );
}

export class MonitorBootstrapFile implements MonitorBootstrapPort {
  constructor(
    private readonly client: S3Client,
    private readonly createCertificate: CertificateFactory = createMonitorCertificate,
  ) {}

  async ensure(session: SessionRecord, abortSignal?: AbortSignal): Promise<string> {
    const target = location(session);
    if (session.monitorCertificate !== null) {
      const stored = await this.readCertificate(session, target, abortSignal);
      if (stored !== session.monitorCertificate) throw new Error('Stored monitor certificate changed');
      return stored;
    }

    const pair = validateMonitorCertificatePair(session, await this.createCertificate(session));
    const command = new PutObjectCommand({
      Bucket: target.bucket,
      Key: target.key,
      Body: encode(session, pair),
      ContentType: 'text/plain; charset=utf-8',
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*',
      Tagging: encodeCertificateTags(pair.certificate),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      abortSignal?.throwIfAborted();
      try {
        await this.client.send(command, sendOptions(abortSignal));
        return pair.certificate;
      } catch (error) {
        abortSignal?.throwIfAborted();
        if (attempt === 0 && isConflict(error, 409, 'ConditionalRequestConflict')) continue;
        if (
          isConflict(error, 412, 'PreconditionFailed') ||
          isConflict(error, 409, 'ConditionalRequestConflict') ||
          canHaveCommitted(error)
        ) {
          try {
            return await this.readCertificate(session, target, abortSignal);
          } catch (readError) {
            if (!(readError instanceof S3ServiceException && readError.$metadata.httpStatusCode === 404)) {
              throw readError;
            }
          }
        }
        throw error;
      }
    }
    throw new Error('Monitor bootstrap upload did not complete');
  }

  private async readCertificate(
    session: SessionRecord,
    target: BootstrapLocation,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const result = await this.client.send(
      new GetObjectTaggingCommand({
        Bucket: target.bucket,
        Key: target.key,
      }),
      sendOptions(abortSignal),
    );
    return decodeCertificateTags(session, result.TagSet);
  }
}

export function createS3Client() {
  return new S3Client({ maxAttempts: 2, requestHandler: createAwsTransport() });
}
