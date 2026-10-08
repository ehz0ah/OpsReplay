import { createPrivateKey, X509Certificate } from 'node:crypto';
import { recordingWorkTiming } from '../../../../packages/contracts/private/recording-work.js';
import type { SessionRecord } from '../start-session/types.js';

const serverAuthOid = '1.3.6.1.5.5.7.3.1';
const maximumCredentialBytes = 16_384;
const millisecondPerSecond = 1000;

export interface MonitorCertificatePair {
  certificate: string;
  privateKey: string;
}

export function monitorCertificateValidity(session: SessionRecord): { from: Date; to: Date } {
  const created = Date.parse(session.view.createdAt);
  const recovery = Date.parse(session.launchRecoveryDeadline);
  const expires =
    recovery + session.accessGrant.timeLimitSeconds * millisecondPerSecond + recordingWorkTiming.postSessionWindowMs;
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
    throw new Error('Invalid monitor certificate validity');
  }
  // X.509 validity has whole-second precision. Round outwards so the certificate
  // covers the complete session interval when stored timestamps contain milliseconds.
  const from = new Date(Math.floor(created / millisecondPerSecond) * millisecondPerSecond);
  const to = new Date(Math.ceil(expires / millisecondPerSecond) * millisecondPerSecond);
  return { from, to };
}

export function validMonitorCertificate(session: SessionRecord, value: string | X509Certificate): boolean {
  try {
    const certificate = typeof value === 'string' ? new X509Certificate(value) : value;
    const expected = monitorCertificateValidity(session);
    return (
      Buffer.byteLength(certificate.toString()) <= maximumCredentialBytes &&
      !certificate.ca &&
      certificate.keyUsage.includes(serverAuthOid) &&
      certificate.subject === certificate.issuer &&
      certificate.publicKey.asymmetricKeyType === 'ec' &&
      certificate.publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
      certificate.verify(certificate.publicKey) &&
      Date.parse(certificate.validFrom) <= expected.from.getTime() &&
      Date.parse(certificate.validTo) >= expected.to.getTime()
    );
  } catch {
    return false;
  }
}

export function validateMonitorCertificatePair(
  session: SessionRecord,
  pair: MonitorCertificatePair,
): MonitorCertificatePair {
  const certificateBytes = Buffer.byteLength(pair.certificate);
  const keyBytes = Buffer.byteLength(pair.privateKey);
  if (
    certificateBytes === 0 ||
    certificateBytes > maximumCredentialBytes ||
    keyBytes === 0 ||
    keyBytes > maximumCredentialBytes
  ) {
    throw new Error('Invalid monitor certificate material');
  }
  try {
    const certificate = new X509Certificate(pair.certificate);
    const privateKey = createPrivateKey(pair.privateKey);
    if (!validMonitorCertificate(session, certificate) || !certificate.checkPrivateKey(privateKey)) {
      throw new Error('Invalid monitor certificate material');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid monitor certificate material') throw error;
    throw new Error('Invalid monitor certificate material', { cause: error });
  }
  return pair;
}
