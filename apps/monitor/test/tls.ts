import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestTls {
  cert: Buffer;
  certPath: string;
  key: Buffer;
  close(): void;
}

export function testTls(): TestTls {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-monitor-tls-'));
  const config = join(directory, 'openssl.cnf');
  const cert = join(directory, 'cert.pem');
  const key = join(directory, 'key.pem');
  writeFileSync(
    config,
    [
      '[req]',
      'distinguished_name = subject',
      'x509_extensions = extensions',
      'prompt = no',
      '[subject]',
      'CN = opsreplay-monitor',
      '[extensions]',
      'subjectAltName = @names',
      'basicConstraints = critical,CA:TRUE',
      'keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign',
      'extendedKeyUsage = serverAuth',
      '[names]',
      'IP.1 = 127.0.0.1',
      'DNS.1 = localhost',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const result = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', config],
    {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  try {
    if (result.status !== 0) {
      throw new Error(`Could not create temporary TLS certificate: ${result.stderr}`);
    }
    return {
      cert: readFileSync(cert),
      certPath: cert,
      key: readFileSync(key),
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
