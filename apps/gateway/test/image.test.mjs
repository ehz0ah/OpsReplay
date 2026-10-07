import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const challengePath = new URL('../../../content/challenges/wrong-upstream-port/', import.meta.url);
const gatewayBundle = join(root, 'dist/gateway/client.cjs');
const gatewayDriver = fileURLToPath(new URL('image-client.mjs', import.meta.url));
const containers = new Set();

function run(command, args, timeout = 30_000) {
  return spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, cwd: root });
}

function success(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout.trim();
}

const docker = (...args) => run('docker', args);
const exec = (id, ...args) => docker('exec', id, ...args);
const challengeImage = success(docker('image', 'inspect', process.env.OPSREPLAY_CHALLENGE_IMAGE
  ?? 'opsreplay/challenge-wrong-upstream-port:dev', '--format', '{{.Id}}'));
const monitorImage = success(docker('image', 'inspect', process.env.OPSREPLAY_MONITOR_IMAGE
  ?? 'opsreplay/monitor-test:dev', '--format', '{{.Id}}'));

function temporaryTls(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const config = join(directory, 'openssl.cnf');
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  writeFileSync(config, [
    '[req]', 'distinguished_name = subject', 'x509_extensions = extensions', 'prompt = no',
    '[subject]', 'CN = opsreplay-monitor', '[extensions]', 'subjectAltName = @names',
    'basicConstraints = critical,CA:TRUE',
    'keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign',
    'extendedKeyUsage = serverAuth', '[names]', 'IP.1 = 127.0.0.1', '',
  ].join('\n'), { mode: 0o600 });
  const result = run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-config', config]);
  try {
    assert.equal(result.status, 0, result.stderr);
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function removeContainer(name) {
  if (!containers.has(name)) return;
  success(docker('rm', '--force', name));
  containers.delete(name);
}

process.once('exit', () => {
  for (const name of containers) docker('rm', '--force', name);
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

async function eventually(check, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(150);
  }
  assert.fail(message);
}

function runGateway(challenge, secret, certificate, expectTlsFailure = false) {
  const name = 'opsreplay-gateway-client-' + randomUUID();
  const id = success(docker('create', '--name', name,
    '--label', 'opsreplay.test=gateway-monitor', '--network', 'container:' + challenge,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--cpus', '0.25', '--memory', '64m', '--memory-swap', '64m', '--pids-limit', '32',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=4m',
    '--env', 'OPSREPLAY_MONITOR_SECRET=' + secret,
    '--env', 'OPSREPLAY_MONITOR_CA_B64=' + certificate.toString('base64'),
    ...(expectTlsFailure ? ['--env', 'OPSREPLAY_EXPECT_TLS_FAILURE=1'] : []),
    '--mount', `type=bind,src=${gatewayBundle},dst=/test/client.cjs,readonly`,
    '--mount', `type=bind,src=${gatewayDriver},dst=/test/image-client.mjs,readonly`,
    '--entrypoint', 'node', monitorImage, '/test/image-client.mjs'));
  containers.add(name);
  try {
    assert.equal(id.length, 64);
    const result = run('docker', ['start', '--attach', name], 45_000);
    return JSON.parse(success(result));
  } finally {
    removeContainer(name);
  }
}

test('bundled gateway client completes the real container sidecar lifecycle', { timeout: 150_000 }, async () => {
  const tls = temporaryTls('opsreplay-gateway-monitor-tls-');
  let wrongTls;
  const secret = randomBytes(32).toString('base64url');
  const challenge = 'opsreplay-gateway-shop-' + randomUUID();
  const monitor = 'opsreplay-gateway-monitor-' + randomUUID();
  try {
    wrongTls = temporaryTls('opsreplay-gateway-wrong-tls-');
    const challengeId = success(run('sh', [fileURLToPath(new URL('run-local.sh', challengePath)),
      challenge, challengeImage]));
    containers.add(challenge);
    assert.equal(challengeId.length, 64);
    await eventually(() => exec(challenge, 'opsreplay-check-startup').status === 0,
      'Challenge listeners did not start');

    success(docker('run', '--detach', '--name', monitor,
      '--label', 'opsreplay.test=gateway-monitor', '--network', 'container:' + challenge,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '64',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m',
      '--env', 'OPSREPLAY_MONITOR_SECRET=' + secret,
      '--env', 'OPSREPLAY_MONITOR_TLS_CERT_B64=' + tls.cert.toString('base64'),
      '--env', 'OPSREPLAY_MONITOR_TLS_KEY_B64=' + tls.key.toString('base64'),
      monitorImage, '/app/challenge.json'));
    containers.add(monitor);
    await eventually(() => docker('logs', monitor).stdout.includes('monitor_control_listening'),
      'Monitor control server did not start');

    assert.deepEqual(runGateway(challenge, secret, wrongTls.cert, true), { error: 'tls_failed' });
    const result = runGateway(challenge, secret, tls.cert);
    assert.equal(result.health, 'ready');
    assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(result.frameCount > 0);
    assert.equal(result.nextSequence, result.frameCount);
    assert.equal(result.sealed, true);
  } finally {
    removeContainer(monitor);
    removeContainer(challenge);
    wrongTls?.close();
    tls.close();
  }
});
