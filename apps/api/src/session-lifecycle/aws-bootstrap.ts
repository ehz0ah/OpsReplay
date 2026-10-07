import { GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { SessionRecord } from '../start-session/types.js';
import type { MonitorBootstrapPort } from './ports.js';
import { createAwsTransport, sendOptions } from '../shared/aws.js';
import { validateMonitorCertificatePair, type MonitorCertificatePair } from './monitor-certificate-validation.js';
import { createMonitorCertificate } from './monitor-certificate.js';

const maximumBootstrapBytes = 65_536;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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

function decodeBase64(value: string): string {
  if (!base64Pattern.test(value)) throw new Error('Invalid stored monitor bootstrap file');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > 16_384 || decoded.toString('base64') !== value) {
    throw new Error('Invalid stored monitor bootstrap file');
  }
  return decoded.toString('utf8');
}

function decode(session: SessionRecord, value: string): MonitorCertificatePair {
  const lines = value.split('\n');
  if (lines.at(-1) !== '') throw new Error('Invalid stored monitor bootstrap file');
  lines.pop();
  if (lines.length !== 3) throw new Error('Invalid stored monitor bootstrap file');
  const expected = ['OPSREPLAY_MONITOR_SECRET=', 'OPSREPLAY_MONITOR_TLS_CERT_B64=', 'OPSREPLAY_MONITOR_TLS_KEY_B64='];
  const values = lines.map((line, index) => {
    const prefix = expected[index]!;
    if (!line!.startsWith(prefix)) throw new Error('Invalid stored monitor bootstrap file');
    return line!.slice(prefix.length);
  });
  if (values[0] !== session.monitorSecret) throw new Error('Invalid stored monitor bootstrap file');
  try {
    return validateMonitorCertificatePair(session, {
      certificate: decodeBase64(values[1]!),
      privateKey: decodeBase64(values[2]!),
    });
  } catch (error) {
    throw new Error('Invalid stored monitor bootstrap file', { cause: error });
  }
}

async function boundedBody(body: unknown): Promise<string> {
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function') {
    throw new Error('Invalid stored monitor bootstrap file');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of body as AsyncIterable<Uint8Array | string>) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > maximumBootstrapBytes) throw new Error('Invalid stored monitor bootstrap file');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
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
      const stored = await this.read(session, target, abortSignal);
      if (stored.certificate !== session.monitorCertificate) throw new Error('Stored monitor certificate changed');
      return stored.certificate;
    }

    const pair = validateMonitorCertificatePair(session, await this.createCertificate(session));
    const command = new PutObjectCommand({
      Bucket: target.bucket,
      Key: target.key,
      Body: encode(session, pair),
      ContentType: 'text/plain; charset=utf-8',
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*',
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
            return (await this.read(session, target, abortSignal)).certificate;
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

  private async read(
    session: SessionRecord,
    target: BootstrapLocation,
    abortSignal?: AbortSignal,
  ): Promise<MonitorCertificatePair> {
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: target.bucket,
        Key: target.key,
        Range: `bytes=0-${maximumBootstrapBytes}`,
      }),
      sendOptions(abortSignal),
    );
    if ((result.ContentLength ?? 0) > maximumBootstrapBytes) throw new Error('Invalid stored monitor bootstrap file');
    return decode(session, await boundedBody(result.Body));
  }
}

export function createS3Client() {
  return new S3Client({ maxAttempts: 2, requestHandler: createAwsTransport() });
}
