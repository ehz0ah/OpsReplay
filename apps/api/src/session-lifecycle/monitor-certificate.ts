import { generate } from 'selfsigned';
import type { SessionRecord } from '../start-session/types.js';
import {
  monitorCertificateValidity,
  validateMonitorCertificatePair,
  type MonitorCertificatePair,
} from './monitor-certificate-validation.js';

export async function createMonitorCertificate(session: SessionRecord): Promise<MonitorCertificatePair> {
  const expected = monitorCertificateValidity(session);
  const result = await generate([{ name: 'commonName', value: 'opsreplay-monitor' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: expected.from,
    notAfterDate: expected.to,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  });
  return validateMonitorCertificatePair(session, { certificate: result.cert, privateKey: result.private });
}
