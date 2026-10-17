import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const manifest = JSON.parse(readFileSync(new URL('./challenge.json', import.meta.url)));
const image = process.env.OPSREPLAY_DNS_CHALLENGE_IMAGE ?? 'opsreplay/challenge-stale-dns-record:dev';
const containers = new Set();
function docker(...args) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
}
function success(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout.trim();
}
const imageId = success(docker('image', 'inspect', image, '--format', '{{.Id}}'));
const exec = (id, ...args) => docker('exec', id, ...args);
process.once('exit', () => {
  for (const id of containers) docker('rm', '-f', id);
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
async function eventually(check, message) {
  const end = Date.now() + 25_000;
  do {
    if (check()) return;
    await delay(100);
  } while (Date.now() < end);
  assert.fail(message);
}
async function fresh(t) {
  const id = success(
    docker(
      'run',
      '-d',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--init',
      '--cpus',
      '1',
      '--memory',
      '2g',
      '--memory-swap',
      '2g',
      '--pids-limit',
      '128',
      '--security-opt',
      'no-new-privileges=true',
      '--cap-drop',
      'NET_RAW',
      '--cap-drop',
      'SETPCAP',
      '--cap-drop',
      'MKNOD',
      '--cap-drop',
      'AUDIT_WRITE',
      '--cap-drop',
      'SETFCAP',
      '--cap-drop',
      'SYS_CHROOT',
      '--name',
      'opsreplay-dns-test-' + randomUUID(),
      imageId,
    ),
  );
  containers.add(id);
  t.after(() => {
    success(docker('rm', '-f', id));
    containers.delete(id);
  });
  await eventually(() => exec(id, 'opsreplay-check-startup').status === 0, 'DNS environment not ready');
  return id;
}
const status = (id, path, method = 'GET') =>
  Number(
    success(
      exec(
        id,
        'curl',
        '--silent',
        '--max-time',
        '4',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '-X',
        method,
        'http://127.0.0.1' + path,
      ),
    ),
  );
const dns = (id) => success(exec(id, 'dig', 'api.internal', '+short', '+time=1', '+tries=1'));
async function repair(id) {
  for (const command of manifest.referenceFix.commands) success(exec(id, 'sh', '-ec', command));
  await eventually(() => status(id, '/api/checkout', 'POST') === 201, 'Checkout did not recover');
}

test('real DNS fault, partial repair, persisted checkout and a fresh reset', { timeout: 120_000 }, async (t) => {
  const id = await fresh(t);
  assert.equal(status(id, '/'), 200);
  assert.equal(status(id, '/api/checkout', 'POST'), 502);
  assert.equal(dns(id), '127.0.0.3');
  assert.match(success(exec(id, 'ss', '-ltnp')), /127\.0\.0\.2:8080/);
  assert.match(success(exec(id, 'cat', '/var/log/nginx/error.log')), /127\.0\.0\.3:8080/);
  success(exec(id, 'sh', '-ec', manifest.referenceFix.commands[0]));
  success(exec(id, 'sh', '-ec', manifest.referenceFix.commands[1]));
  assert.equal(dns(id), '127.0.0.2');
  assert.equal(status(id, '/api/checkout', 'POST'), 502, 'DNS-only repair must leave cached upstream in use');
  await repair(id);
  const order = JSON.parse(
    success(
      exec(id, 'curl', '--silent', '--fail', '--json', '{"reference":"dns-test"}', 'http://127.0.0.1/api/checkout'),
    ),
  );
  const stored = JSON.parse(success(exec(id, 'curl', '--silent', '--fail', `http://127.0.0.1/api/orders/${order.id}`)));
  assert.equal(stored.reference, 'dns-test');
  assert.equal(stored.status, 'confirmed');
  const reset = await fresh(t);
  assert.equal(dns(reset), '127.0.0.3');
  assert.equal(status(reset, '/api/checkout', 'POST'), 502);
});
test(
  'broken DNS reload keeps storefront available, restart causes the authored outage',
  { timeout: 120_000 },
  async (t) => {
    const id = await fresh(t),
      trap = manifest.traps[0];
    for (const command of trap.safeAlternative.commands.slice(0, -1)) {
      const result = exec(id, 'sh', '-ec', command);
      if (command === 'service coredns restart') assert.notEqual(result.status, 0);
      else success(result);
    }
    assert.notEqual(exec(id, 'sh', '-ec', trap.safeAlternative.commands.at(-1)).status, 0);
    assert.equal(status(id, '/'), 200);
    assert.notEqual(exec(id, 'service', 'nginx', 'restart').status, 0);
    assert.notEqual(exec(id, 'curl', '--silent', '--max-time', '2', 'http://127.0.0.1/').status, 0);
    success(
      docker(
        'cp',
        fileURLToPath(new URL('./image/rootfs/etc/coredns/internal.db', import.meta.url)),
        id + ':/etc/coredns/internal.db',
      ),
    );
    success(exec(id, 'service', 'coredns', 'restart'));
    success(exec(id, 'service', 'nginx', 'start'));
    await repair(id);
  },
);
test('moving the API listener is accepted as an alternative real fix', { timeout: 60_000 }, async (t) => {
  const id = await fresh(t);
  success(exec(id, 'sed', '-i', 's/127.0.0.2:8080/127.0.0.3:8080/', '/etc/shop/gunicorn.conf.py'));
  success(exec(id, 'service', 'shop', 'restart'));
  await eventually(() => status(id, '/api/checkout', 'POST') === 201, 'Alternative repair did not recover checkout');
  assert.equal(dns(id), '127.0.0.3');
});
