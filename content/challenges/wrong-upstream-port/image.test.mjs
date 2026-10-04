import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('./challenge.json', import.meta.url)));
const runScript = fileURLToPath(new URL('./run-local.sh', import.meta.url));
const imageTag = process.env.OPSREPLAY_CHALLENGE_IMAGE ?? 'opsreplay/challenge-wrong-upstream-port:dev';
const containers = new Set();

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
}

function success(result) {
  assert.equal(result.status, 0, result.error?.message ?? (result.stderr + result.stdout));
  return result.stdout.trim();
}

const docker = (...args) => run('docker', args);
const exec = (id, ...args) => docker('exec', id, ...args);
// Pin the built image for the entire run, even if another build changes the dev tag.
const imageId = success(docker('image', 'inspect', imageTag, '--format', '{{.Id}}'));

process.once('exit', () => {
  for (const id of containers) docker('rm', '--force', id);
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

async function eventually(check, message) {
  const deadline = Date.now() + 25_000;
  do {
    if (check()) return;
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function fresh(t) {
  const name = 'opsreplay-port-test-' + randomUUID();
  const id = success(run('sh', [runScript, name, imageId]));
  assert.match(id, /^[a-f0-9]{64}$/);
  containers.add(id);
  t.after(() => {
    success(docker('rm', '--force', id));
    containers.delete(id);
  });
  try {
    await eventually(() => {
      const state = JSON.parse(success(docker('inspect', '--format', '{{json .State}}', id)));
      assert.equal(state.Status, 'running', 'Container exited during startup');
      return state.Health.Status === 'healthy';
    }, 'Service listeners did not become healthy');
  } catch (error) {
    t.diagnostic(docker('logs', '--tail', '40', id).stdout);
    throw error;
  }
  return id;
}

function http(id, path, { port = 80, json, method } = {}) {
  const args = ['curl', '--silent', '--show-error', '--connect-timeout', '1', '--max-time', '4',
    '--write-out', '\n%{http_code}'];
  if (json !== undefined) args.push('--json', JSON.stringify(json));
  if (method) args.push('--request', method);
  args.push(`http://127.0.0.1:${port}${path}`);
  const result = exec(id, ...args);
  const split = result.stdout.lastIndexOf('\n');
  return { code: result.status, status: Number(result.stdout.slice(split + 1)),
    body: result.stdout.slice(0, split), error: result.stderr };
}

function expectHttp(response, status) {
  assert.equal(response.code, 0, response.error);
  assert.equal(response.status, status, response.body);
  return response.body;
}

function sql(id, statement) {
  return success(exec(id, 'runuser', '-u', 'postgres', '--', 'psql', '-X', '-d', 'shop',
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement));
}

async function repair(id) {
  for (const command of manifest.referenceFix.commands) success(exec(id, 'sh', '-ec', command));
  await eventually(() => http(id, '/').status === 200, 'nginx did not apply the reference repair');
}

test('fresh image has real services, observable 502 evidence, and restricted local settings', async t => {
  const id = await fresh(t);
  expectHttp(http(id, '/'), 502);
  expectHttp(http(id, '/', { port: 8080 }), 200);
  success(exec(id, 'nginx', '-t'));
  for (const service of manifest.environment.services) {
    for (const path of [...service.configFiles, ...service.logFiles]) success(exec(id, 'test', '-f', path));
  }
  const observed = [success(exec(id, 'cat', '/var/log/nginx/error.log')),
    success(exec(id, 'ss', '-ltnp')), success(exec(id, 'cat', '/etc/nginx/nginx.conf'))];
  for (const [index, evidence] of manifest.debrief.keyEvidence.entries()) {
    for (const pattern of evidence.outputPatterns) assert.match(observed[index], new RegExp(pattern));
  }
  for (const tool of ['nano', 'vi', 'vim', 'curl', 'ss', 'ps', 'less', 'psql']) {
    success(exec(id, 'sh', '-ec', 'command -v "$1"', 'tool-check', tool));
  }
  assert.equal(success(exec(id, 'id', '-u')), '0');
  assert.equal(sql(id, 'SELECT count(*) FROM orders'), '0');
  const [inspect] = JSON.parse(success(docker('inspect', id)));
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.deepEqual(inspect.Mounts, []);
  assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(inspect.HostConfig.CapDrop.some(cap => cap.replace(/^CAP_/, '') === 'NET_RAW'));
  const capabilities = success(exec(id, 'cat', '/proc/self/status')).match(/^CapEff:\s*([0-9a-f]+)$/m);
  assert.ok(capabilities);
  assert.equal(BigInt('0x' + capabilities[1]) & (1n << 13n), 0n, 'NET_RAW must actually be absent');
  assert.ok(inspect.HostConfig.SecurityOpt.includes('no-new-privileges=true'));
  success(exec(id, 'test', '!', '-e', '/var/run/docker.sock'));
});

test('reference fix stores orders, survives service/container restarts, and a fresh attempt resets', async t => {
  const id = await fresh(t);
  await repair(id);
  const reference = randomUUID();
  const order = JSON.parse(expectHttp(http(id, '/api/checkout', { json: { reference } }), 201));
  assert.match(order.id, /^[a-f0-9]{32}$/);
  assert.equal(order.reference, reference);
  assert.equal(order.status, 'confirmed');
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  assert.deepEqual(JSON.parse(sql(id,
    `SELECT row_to_json(saved) FROM (SELECT id, reference, status FROM orders WHERE id = '${order.id}') saved`)), order);
  success(exec(id, 'service', 'shop', 'restart'));
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  success(exec(id, 'service', 'postgres', 'stop'));
  expectHttp(http(id, '/api/orders/' + order.id), 503);
  success(exec(id, 'service', 'postgres', 'start'));
  await eventually(() => http(id, '/api/orders/' + order.id).status === 200, 'Database did not restart');
  success(docker('restart', '--time', '10', id));
  await eventually(() => http(id, '/api/orders/' + order.id).status === 200, 'Container did not restart');
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);

  const retry = await fresh(t);
  expectHttp(http(retry, '/'), 502);
  assert.equal(sql(retry, 'SELECT count(*) FROM orders'), '0');
  assert.match(success(exec(retry, 'cat', '/etc/nginx/nginx.conf')), /proxy_pass http:\/\/127\.0\.0\.1:8081;/);
});

test('checkout handles absent references, invalid input, and missing orders without false success', async t => {
  const id = await fresh(t);
  await repair(id);
  const first = JSON.parse(expectHttp(http(id, '/api/checkout', { json: {} }), 201));
  const second = JSON.parse(expectHttp(http(id, '/api/checkout', { json: {} }), 201));
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.reference, second.reference);
  const emptyRequest = JSON.parse(expectHttp(http(id, '/api/checkout', { method: 'POST' }), 201));
  assert.ok(emptyRequest.reference);
  for (const json of [[], { reference: '' }, { reference: 12 }, { reference: 'a'.repeat(129) }]) {
    expectHttp(http(id, '/api/checkout', { json }), 400);
  }
  expectHttp(http(id, '/api/checkout', { json: { reference: 'a'.repeat(5000) } }), 413);
  expectHttp(http(id, '/api/orders/missing'), 404);
  assert.equal(sql(id, 'SELECT count(*) FROM orders'), '3');
});

test('invalid reload fails but leaves the original nginx workers serving 502', async t => {
  const id = await fresh(t);
  const commands = manifest.traps[0].safeAlternative.commands;
  for (const command of commands.slice(0, -1)) success(exec(id, 'sh', '-ec', command));
  assert.notEqual(exec(id, 'sh', '-ec', commands.at(-1)).status, 0);
  assert.notEqual(exec(id, 'nginx', '-t').status, 0);
  for (let check = 0; check < 5; check++) expectHttp(http(id, '/'), 502);
  success(exec(id, 'opsreplay-health'));
});

test('invalid restart takes nginx down and a valid configuration can start it again', async t => {
  const id = await fresh(t);
  const commands = manifest.traps[0].commands;
  for (const command of commands.slice(0, -1)) success(exec(id, 'sh', '-ec', command));
  assert.notEqual(exec(id, 'sh', '-ec', commands.at(-1)).status, 0);
  assert.equal(http(id, '/').code, 7, 'Proxy should refuse connections');
  expectHttp(http(id, '/', { port: 8080 }), 200);
  assert.notEqual(exec(id, 'opsreplay-health').status, 0);
  success(exec(id, 'sed', '-i', 's#proxy_pass http://127.0.0.1:8080$#proxy_pass http://127.0.0.1:8080;#', '/etc/nginx/nginx.conf'));
  success(exec(id, 'nginx', '-t'));
  success(exec(id, 'service', 'nginx', 'restart'));
  expectHttp(http(id, '/'), 200);
});

test('an incomplete database setup is rejected on restart', async t => {
  const id = await fresh(t);
  success(exec(id, 'rm', '/var/lib/postgresql/data/.opsreplay-initialized'));
  success(docker('restart', '--time', '10', id));
  await eventually(() => success(docker('inspect', '--format', '{{.State.Status}}', id)) === 'exited',
    'An incomplete database must not start the application');
  assert.equal(success(docker('inspect', '--format', '{{.State.ExitCode}}', id)), '1');
});
