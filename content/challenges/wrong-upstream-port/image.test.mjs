import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('./challenge.json', import.meta.url)));
const runScript = fileURLToPath(new URL('./run-local.sh', import.meta.url));
const terminalTest = readFileSync(new URL('./terminal.test.py', import.meta.url), 'utf8');
const imageTag = process.env.OPSREPLAY_CHALLENGE_IMAGE ?? 'opsreplay/challenge-wrong-upstream-port:dev';
const containers = new Set();

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function success(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout.trim();
}

const docker = (...args) => run('docker', args);
const exec = (id, ...args) => docker('exec', id, ...args);
const terminal = (id, ...args) =>
  run('docker', ['exec', '--interactive', id, 'python3', '-', ...args], {
    input: terminalTest,
    timeout: 45_000,
  });
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
      return exec(id, 'opsreplay-check-startup').status === 0;
    }, 'Initial service listeners did not become ready');
  } catch (error) {
    t.diagnostic(docker('logs', '--tail', '40', id).stdout);
    throw error;
  }
  return id;
}

function http(id, path, { port = 80, json, body, contentType, method } = {}) {
  const args = [
    'curl',
    '--silent',
    '--show-error',
    '--connect-timeout',
    '1',
    '--max-time',
    '4',
    '--write-out',
    '\n%{http_code}',
  ];
  if (json !== undefined) args.push('--json', JSON.stringify(json));
  if (body !== undefined) args.push('--data-binary', body);
  if (contentType !== undefined) args.push('--header', 'Content-Type: ' + contentType);
  if (method) args.push('--request', method);
  args.push(`http://127.0.0.1:${port}${path}`);
  const result = exec(id, ...args);
  const split = result.stdout.lastIndexOf('\n');
  return {
    code: result.status,
    status: Number(result.stdout.slice(split + 1)),
    body: result.stdout.slice(0, split),
    error: result.stderr,
  };
}

function expectHttp(response, status) {
  assert.equal(response.code, 0, response.error);
  assert.equal(response.status, status, response.body);
  return response.body;
}

function sql(id, statement) {
  return success(
    exec(
      id,
      'runuser',
      '-u',
      'postgres',
      '--',
      'psql',
      '-X',
      '-d',
      'shop',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ),
  );
}

function nginxWorkers(id) {
  const master = success(exec(id, 'supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'pid', 'nginx'));
  return new Set(childPids(id, master));
}

function childPids(id, parentPid) {
  return success(exec(id, 'ps', '-eo', 'pid=,ppid='))
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, parent]) => parent === parentPid)
    .map(([pid]) => pid);
}

async function repair(id) {
  const oldWorkers = nginxWorkers(id);
  assert.ok(oldWorkers.size > 0, 'nginx must have workers before the repair');
  for (const command of manifest.referenceFix.commands) success(exec(id, 'sh', '-ec', command));
  // Reload is asynchronous: one new worker can return 200 while old workers still return 502.
  await eventually(() => {
    const workers = nginxWorkers(id);
    return workers.size > 0 && [...oldWorkers].every((pid) => !workers.has(pid));
  }, 'Old nginx workers did not exit after the reference repair');
  expectHttp(http(id, '/'), 200);
}

test('fresh image has real services, observable 502 evidence, and restricted local settings', async (t) => {
  const id = await fresh(t);
  expectHttp(http(id, '/'), 502);
  expectHttp(http(id, '/', { port: 8080 }), 200);
  success(exec(id, 'nginx', '-t'));
  for (const service of manifest.environment.services) {
    for (const path of [...service.configFiles, ...service.logFiles]) success(exec(id, 'test', '-f', path));
  }
  const observed = [
    success(exec(id, 'cat', '/var/log/nginx/error.log')),
    success(exec(id, 'ss', '-ltnp')),
    success(exec(id, 'cat', '/etc/nginx/nginx.conf')),
  ];
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
  assert.equal(inspect.HostConfig.NanoCpus, 1_000_000_000);
  assert.equal(inspect.HostConfig.Memory, manifest.environment.memoryMiB * 1024 * 1024);
  assert.equal(inspect.HostConfig.MemorySwap, inspect.HostConfig.Memory, 'Swap must be disabled');
  assert.equal(inspect.HostConfig.PidsLimit, 128);
  assert.deepEqual(inspect.Mounts, []);
  assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
  assert.ok(inspect.HostConfig.CapDrop.some((cap) => cap.replace(/^CAP_/, '') === 'NET_RAW'));
  const capabilities = success(exec(id, 'cat', '/proc/self/status')).match(/^CapEff:\s*([0-9a-f]+)$/m);
  assert.ok(capabilities);
  assert.equal(BigInt('0x' + capabilities[1]) & (1n << 13n), 0n, 'NET_RAW must actually be absent');
  assert.ok(inspect.HostConfig.SecurityOpt.includes('no-new-privileges=true'));
  success(exec(id, 'test', '!', '-e', '/var/run/docker.sock'));
});

test('startup checks are explicit and stopping a service does not end the container', async (t) => {
  const id = await fresh(t);
  const [before] = JSON.parse(success(docker('inspect', id)));
  assert.deepEqual(before.Config.Healthcheck, { Test: ['NONE'] });
  assert.equal(before.State.Health, undefined);
  success(exec(id, 'service', 'shop', 'stop'));
  assert.equal(http(id, '/', { port: 8080 }).code, 7);
  const startup = exec(id, 'opsreplay-check-startup');
  assert.equal(startup.status, 1);
  assert.match(startup.stderr, /8080/);
  const [stopped] = JSON.parse(success(docker('inspect', id)));
  assert.equal(stopped.State.Status, 'running');
  assert.equal(stopped.State.Health, undefined);
  success(exec(id, 'service', 'shop', 'start'));
  success(exec(id, 'opsreplay-check-startup'));
});

test('private terminal preserves one shell, fences stale input, and fails closed', async (t) => {
  const id = await fresh(t);
  const secret = randomUUID();
  success(terminal(id, secret));

  const terminalLog = success(exec(id, 'cat', '/var/log/supervisor/terminal.log'));
  const supervisorLog = success(exec(id, 'cat', '/var/log/supervisor/supervisord.log'));
  const containerLog = docker('logs', id);
  assert.ok(!terminalLog.includes(secret), 'Terminal content must not enter the terminal log');
  assert.ok(!supervisorLog.includes(secret), 'Terminal content must not enter the Supervisor log');
  assert.ok(!containerLog.stdout.includes(secret), 'Terminal content must not enter container stdout');
  assert.ok(!containerLog.stderr.includes(secret), 'Terminal content must not enter container stderr');

  success(exec(id, 'supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'stop', 'terminal'));
  await eventually(
    () =>
      exec(id, 'python3', '-c', 'import socket; socket.create_connection(("127.0.0.1", 7681), timeout=0.2)').status !==
      0,
    'Terminal listener remained open after shutdown',
  );
  assert.notEqual(
    exec(id, 'supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'start', 'terminal').status,
    0,
    'The same container must not open a new unfenced shell',
  );
  assert.match(success(exec(id, 'cat', '/var/log/supervisor/terminal.log')), /Refusing to open a new shell/);
  assert.equal(success(docker('inspect', '--format', '{{.State.Status}}', id)), 'running');
});

test('exiting the shell stops the terminal server without replacing the shell', async (t) => {
  const id = await fresh(t);
  success(terminal(id, 'shell-exit'));
  await eventually(() => {
    const status = exec(id, 'supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'status', 'terminal');
    return /FATAL|EXITED/.test(status.stdout);
  }, 'Terminal server remained active after its shell exited');
  assert.match(success(exec(id, 'cat', '/var/log/supervisor/terminal.log')), /Refusing to open a replacement shell/);
  const startup = exec(id, 'opsreplay-check-startup');
  assert.equal(startup.status, 1);
  assert.match(startup.stderr, /7681/);
  assert.equal(success(docker('inspect', '--format', '{{.State.Status}}', id)), 'running');
});

test('moving the application to port 8081 is a valid repair', async (t) => {
  const id = await fresh(t);
  success(exec(id, 'sed', '-i', 's/127.0.0.1:8080/127.0.0.1:8081/', '/etc/shop/gunicorn.conf.py'));
  success(exec(id, 'service', 'shop', 'restart'));
  const reference = randomUUID();
  const order = JSON.parse(expectHttp(http(id, '/api/checkout', { json: { reference } }), 201));
  assert.equal(order.reference, reference);
  assert.equal(order.status, 'confirmed');
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  assert.equal(sql(id, 'SELECT count(*) FROM orders'), '1');
  assert.equal(http(id, '/', { port: 8080 }).code, 7);
  const [inspect] = JSON.parse(success(docker('inspect', id)));
  assert.equal(inspect.State.Status, 'running');
  assert.equal(inspect.State.Health, undefined);
});

test('reference fix stores orders, survives service/container restarts, and a fresh attempt resets', async (t) => {
  const id = await fresh(t);
  await repair(id);
  const reference = randomUUID();
  const order = JSON.parse(expectHttp(http(id, '/api/checkout', { json: { reference } }), 201));
  assert.match(order.id, /^[a-f0-9]{32}$/);
  assert.equal(order.reference, reference);
  assert.equal(order.status, 'confirmed');
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  assert.deepEqual(
    JSON.parse(
      sql(
        id,
        `SELECT row_to_json(saved) FROM (SELECT id, reference, status FROM orders WHERE id = '${order.id}') saved`,
      ),
    ),
    order,
  );
  success(exec(id, 'service', 'shop', 'restart'));
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  success(exec(id, 'service', 'postgres', 'stop'));
  expectHttp(http(id, '/api/orders/' + order.id), 503);
  success(exec(id, 'service', 'postgres', 'start'));
  await eventually(() => http(id, '/api/orders/' + order.id).status === 200, 'Database did not restart');
  success(docker('restart', '--time', '10', id));
  await eventually(() => http(id, '/api/orders/' + order.id).status === 200, 'Container did not restart');
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  const startup = exec(id, 'opsreplay-check-startup');
  assert.equal(startup.status, 1, 'A container restart must not open a new unfenced shell');
  assert.match(startup.stderr, /7681/);

  const retry = await fresh(t);
  expectHttp(http(retry, '/'), 502);
  assert.equal(sql(retry, 'SELECT count(*) FROM orders'), '0');
  assert.match(success(exec(retry, 'cat', '/etc/nginx/nginx.conf')), /proxy_pass http:\/\/127\.0\.0\.1:8081;/);
});

test('checkout handles absent references, invalid input, and missing orders without false success', async (t) => {
  const id = await fresh(t);
  await repair(id);
  const first = JSON.parse(expectHttp(http(id, '/api/checkout', { json: {} }), 201));
  const second = JSON.parse(expectHttp(http(id, '/api/checkout', { json: {} }), 201));
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.reference, second.reference);
  const emptyRequest = JSON.parse(expectHttp(http(id, '/api/checkout', { method: 'POST' }), 201));
  assert.ok(emptyRequest.reference);
  for (const json of [
    null,
    [],
    { extra: true },
    { reference: '' },
    { reference: 12 },
    { reference: 'a'.repeat(129) },
  ]) {
    expectHttp(http(id, '/api/checkout', { json }), 400);
  }
  for (const request of [
    { body: '{', contentType: 'application/json' },
    { body: ' ', contentType: 'application/json' },
    { body: '{"reference":"missing-type"}', contentType: '' },
    { body: '{"reference":"wrong-type"}', contentType: 'text/plain' },
  ]) {
    assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/checkout', request), 400)), { error: 'invalid_checkout' });
  }
  for (const port of [80, 8080]) {
    expectHttp(http(id, '/api/checkout', { port, json: { reference: 'a'.repeat(5000) } }), 413);
  }
  expectHttp(http(id, '/api/orders/missing'), 404);
  assert.equal(sql(id, 'SELECT count(*) FROM orders'), '3');
});

test('shop reload applies Gunicorn settings but environment changes require restart', async (t) => {
  const id = await fresh(t);
  await repair(id);
  const master = success(exec(id, 'supervisorctl', '-c', '/etc/supervisor/supervisord.conf', 'pid', 'shop'));
  await eventually(() => childPids(id, master).length === 2, 'Initial shop workers did not start');
  const oldWorkers = childPids(id, master);
  success(exec(id, 'sed', '-i', 's/workers = 2/workers = 1/', '/etc/shop/gunicorn.conf.py'));
  success(exec(id, 'sed', '-i', 's/dbname=shop/dbname=missing_shop/', '/etc/shop/shop.env'));
  success(exec(id, 'service', 'shop', 'reload'));
  await eventually(() => {
    const workers = childPids(id, master);
    return workers.length === 1 && !oldWorkers.includes(workers[0]);
  }, 'Shop did not reload its worker configuration');
  const order = JSON.parse(expectHttp(http(id, '/api/checkout', { json: { reference: randomUUID() } }), 201));
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/orders/' + order.id), 200)), order);
  success(exec(id, 'service', 'shop', 'restart'));
  assert.deepEqual(JSON.parse(expectHttp(http(id, '/api/checkout', { json: {} }), 503)), {
    error: 'database_unavailable',
  });
});

test('invalid reload fails but leaves the original nginx workers serving 502', async (t) => {
  const id = await fresh(t);
  const commands = manifest.traps[0].safeAlternative.commands;
  for (const command of commands.slice(0, -1)) success(exec(id, 'sh', '-ec', command));
  assert.notEqual(exec(id, 'sh', '-ec', commands.at(-1)).status, 0);
  assert.notEqual(exec(id, 'nginx', '-t').status, 0);
  for (let check = 0; check < 5; check++) expectHttp(http(id, '/'), 502);
  assert.equal(success(docker('inspect', '--format', '{{.State.Status}}', id)), 'running');
});

test('invalid restart takes nginx down and a valid configuration can start it again', async (t) => {
  const id = await fresh(t);
  const commands = manifest.traps[0].commands;
  for (const command of commands.slice(0, -1)) success(exec(id, 'sh', '-ec', command));
  assert.notEqual(exec(id, 'sh', '-ec', commands.at(-1)).status, 0);
  assert.equal(http(id, '/').code, 7, 'Proxy should refuse connections');
  expectHttp(http(id, '/', { port: 8080 }), 200);
  assert.equal(success(docker('inspect', '--format', '{{.State.Status}}', id)), 'running');
  success(
    exec(
      id,
      'sed',
      '-i',
      's#proxy_pass http://127.0.0.1:8080$#proxy_pass http://127.0.0.1:8080;#',
      '/etc/nginx/nginx.conf',
    ),
  );
  success(exec(id, 'nginx', '-t'));
  success(exec(id, 'service', 'nginx', 'restart'));
  expectHttp(http(id, '/'), 200);
});

test('an incomplete database setup is rejected on restart', async (t) => {
  const id = await fresh(t);
  success(exec(id, 'rm', '/var/lib/postgresql/data/.opsreplay-initialized'));
  success(docker('restart', '--time', '10', id));
  await eventually(
    () => success(docker('inspect', '--format', '{{.State.Status}}', id)) === 'exited',
    'An incomplete database must not start the application',
  );
  assert.equal(success(docker('inspect', '--format', '{{.State.ExitCode}}', id)), '1');
});
