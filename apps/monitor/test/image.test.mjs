import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const challengePath = new URL('../../../content/challenges/wrong-upstream-port/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('challenge.json', challengePath)));
const containers = new Set();
const followers = new Set();

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, cwd: root });
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

process.once('exit', () => {
  for (const child of followers) child.kill();
  for (const id of containers) docker('rm', '--force', id);
});
process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));

async function eventually(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(150);
  }
  assert.fail(message);
}

async function fresh(t) {
  const id = success(run('sh', [fileURLToPath(new URL('run-local.sh', challengePath)),
    'opsreplay-monitor-shop-' + randomUUID(), challengeImage]));
  containers.add(id);
  t.after(() => { success(docker('rm', '--force', id)); containers.delete(id); });
  await eventually(() => exec(id, 'opsreplay-check-startup').status === 0, 'Shop listeners did not start', 30_000);
  return id;
}

function startMonitor(t, challenge, seconds = '180') {
  const id = success(docker('run', '--detach', '--name', 'opsreplay-monitor-test-' + randomUUID(),
    '--label', 'opsreplay.test=monitor', '--network', 'container:' + challenge,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--cpus', '0.5', '--memory', '128m', '--memory-swap', '128m', '--pids-limit', '64',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m', monitorImage, '/app/challenge.json', seconds));
  containers.add(id);
  const records = [];
  let pending = '';
  let stderr = '';
  let parseError;
  const follow = spawn('docker', ['logs', '--follow', id], { stdio: ['ignore', 'pipe', 'pipe'] });
  followers.add(follow);
  follow.stdout.setEncoding('utf8');
  follow.stdout.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { records.push(JSON.parse(line)); } catch { parseError = 'Invalid monitor JSON'; }
    }
    if (pending.length > 65536 || records.length > 2000) parseError = 'Monitor output exceeded test bounds';
  });
  follow.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  follow.on('error', error => { parseError = error.message; });
  t.after(() => {
    follow.kill();
    followers.delete(follow);
    success(docker('rm', '--force', id));
    containers.delete(id);
  });
  const all = () => {
    assert.equal(parseError, undefined);
    assert.equal(stderr, '', stderr);
    return records;
  };
  return { id, records, all, errors: () => stderr,
    metrics: () => all().filter(r => r.payload?.type === 'metrics').map(r => r.payload),
    events: signal => all().filter(r => r.payload?.type === 'timeline' && r.payload.event.signal === signal)
      .map(r => r.payload.event),
  };
}

async function stopMonitor(monitor) {
  success(docker('kill', '--signal', 'TERM', monitor.id));
  assert.equal(success(docker('wait', monitor.id)), '0', success(docker('logs', monitor.id)));
  await eventually(() => monitor.all().some(r => r.type === 'monitor_sealed'), 'No sealed measurement output');
}

async function repaired(t, monitor, repair) {
  const previousSustaining = monitor.events('recovery_sustaining').length;
  await repair();
  await eventually(() => monitor.events('recovery_sustaining').length > previousSustaining,
    'Checkout did not start passing after repair');
  assert.equal(monitor.events('recovered').length, 0, 'One passing check is not sustained recovery');
  try {
    await eventually(() => monitor.events('recovered').length === 1, 'Checkout did not remain healthy for 60 seconds', 90_000);
  } catch (error) {
    t.diagnostic(JSON.stringify(monitor.all().slice(-24)));
    throw error;
  }
  const sustained = monitor.events('recovery_sustaining').at(-1);
  const recovered = monitor.events('recovered')[0];
  const elapsed = Date.parse(recovered.at) - Date.parse(sustained.at);
  assert.ok(elapsed >= 60_000, `Recovery was premature: ${elapsed} ms`);
  t.diagnostic(`Actual sustained recovery: ${elapsed} ms`);
  await eventually(() => monitor.metrics().at(-1)?.recovery.state === 'met', 'Recovery metric not emitted', 7000);
  const metric = monitor.metrics().at(-1);
  assert.equal(metric.sample.values.error_rate, 0);
  assert.ok(metric.sample.values.request_rate > 0);
  assert.ok(metric.sample.values.latency_p95 >= 0);
  assert.equal(Object.hasOwn(metric.sample.values, 'cpu'), false);
  assert.equal(Object.hasOwn(metric.sample.values, 'memory'), false);
}

test('sidecar measures the real fault, safe reload, harmful restart, and reference recovery', { timeout: 180_000 }, async t => {
  const shop = await fresh(t);
  const monitor = startMonitor(t, shop);
  await eventually(() => monitor.metrics().some(m => m.counters.failedRequests > 0), 'Initial failures were not measured');
  const [inspect] = JSON.parse(success(docker('inspect', monitor.id)));
  assert.equal(inspect.HostConfig.NetworkMode, 'container:' + shop);
  assert.equal(inspect.HostConfig.Privileged, false);
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.PidMode, '');
  assert.ok(inspect.HostConfig.CapDrop.includes('ALL'));
  assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(success(exec(monitor.id, 'id', '-u')), '1000');
  success(exec(shop, 'test', '!', '-e', '/app/core.cjs'));

  const trap = manifest.traps[0];
  success(exec(shop, 'sh', '-ec', trap.safeAlternative.commands[0]));
  assert.notEqual(exec(shop, 'sh', '-ec', trap.safeAlternative.commands[1]).status, 0);
  await delay(6000);
  assert.equal(monitor.events('outage_started').length, 0, 'Failed reload should preserve the listener');
  assert.notEqual(exec(shop, 'service', 'nginx', 'restart').status, 0);
  await eventually(() => monitor.events('outage_started').length === 1, 'Stopped proxy outage was not measured');
  assert.equal(success(docker('inspect', '--format', '{{.State.Status}}', monitor.id)), 'running');

  await repaired(t, monitor, async () => {
    success(docker('cp', fileURLToPath(new URL('image/rootfs/etc/nginx/nginx.conf', challengePath)), shop + ':/etc/nginx/nginx.conf'));
    success(exec(shop, 'service', 'nginx', 'start'));
    await eventually(() => exec(shop, 'sh', '-ec', 'test -s /run/nginx.pid && kill -0 "$(cat /run/nginx.pid)"').status === 0,
      'nginx did not finish writing its PID before reload');
    for (const command of manifest.referenceFix.commands) success(exec(shop, 'sh', '-ec', command));
  });
  assert.equal(monitor.events('outage_ended').length, 1);
  const count = Number(success(exec(shop, 'runuser', '-u', 'postgres', '--', 'psql', '-X', '-d', 'shop',
    '-At', '-c', 'SELECT count(*) FROM orders')));
  assert.ok(count > 60 && count < 1000, `Unexpected test order count: ${count}`);
  const frames = monitor.all().filter(r => r.sequence);
  assert.deepEqual(frames.map(r => r.sequence), Array.from({ length: frames.length }, (_, i) => i + 1));
  const output = JSON.stringify(monitor.all());
  for (const hidden of ['plantedFault', 'referenceFix', 'validators', 'proxy_pass', 'MONITOR_SECRET']) {
    assert.ok(!output.includes(hidden), `Monitor output included ${hidden}`);
  }
  await stopMonitor(monitor);

  const alreadyHealthy = startMonitor(t, shop, '5');
  assert.equal(success(docker('wait', alreadyHealthy.id)), '1');
  await eventually(() => alreadyHealthy.errors().includes('initial_state_failed'), 'Healthy image should fail initial incident verification');
});

test('sidecar accepts moving the application listener as a real alternative repair', { timeout: 150_000 }, async t => {
  const shop = await fresh(t);
  const monitor = startMonitor(t, shop);
  await eventually(() => monitor.metrics().some(m => m.counters.failedRequests > 0), 'Initial failures were not measured');
  await repaired(t, monitor, async () => {
    success(exec(shop, 'sed', '-i', 's/127.0.0.1:8080/127.0.0.1:8081/', '/etc/shop/gunicorn.conf.py'));
    success(exec(shop, 'service', 'shop', 'restart'));
  });
  assert.equal(monitor.events('outage_started').length, 0, 'Changing the app listener does not stop the proxy');
  await stopMonitor(monitor);
});
