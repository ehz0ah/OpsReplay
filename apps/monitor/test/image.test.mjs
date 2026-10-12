import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ReferenceEnvironmentStack } from '../../../infra/reference-environment-stack.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const challengePath = new URL('../../../content/challenges/wrong-upstream-port/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('challenge.json', challengePath)));
const containers = new Set();
const followers = new Set();
const watchedVolumes = new Map();
const synthesisDirectory = mkdtempSync(join(tmpdir(), 'opsreplay-reference-image-'));
let task;
try {
  task = Template.fromStack(
    new ReferenceEnvironmentStack(new App({ outdir: synthesisDirectory }), 'ReferenceImageTest'),
  ).toJSON().Resources.ReferenceTask.Properties;
} finally {
  rmSync(synthesisDirectory, { recursive: true, force: true });
}
const challengeSettings = task.ContainerDefinitions.find((container) => container.Name === 'challenge');
const monitorSettings = task.ContainerDefinitions.find((container) => container.Name === 'monitor');

function resourceFlags(settings) {
  return [
    '--init',
    '--user',
    settings.User,
    '--cpu-shares',
    String(settings.Cpu),
    '--memory',
    `${settings.Memory}m`,
    '--memory-swap',
    `${settings.Memory}m`,
    ...settings.LinuxParameters.Capabilities.Drop.flatMap((capability) => ['--cap-drop', capability]),
    ...(settings.ReadonlyRootFilesystem ? ['--read-only'] : []),
  ];
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, cwd: root });
}
function success(result) {
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  return result.stdout.trim();
}
const docker = (...args) => run('docker', args);
const exec = (id, ...args) => docker('exec', id, ...args);
const challengeImage = success(
  docker(
    'image',
    'inspect',
    process.env.OPSREPLAY_CHALLENGE_IMAGE ?? 'opsreplay/challenge-wrong-upstream-port:dev',
    '--format',
    '{{.Id}}',
  ),
);
const monitorImage = success(
  docker(
    'image',
    'inspect',
    process.env.OPSREPLAY_MONITOR_IMAGE ?? 'opsreplay/monitor-test:dev',
    '--format',
    '{{.Id}}',
  ),
);
const clientImage = success(
  docker(
    'image',
    'inspect',
    process.env.OPSREPLAY_MONITOR_CLIENT_IMAGE ?? process.env.OPSREPLAY_MONITOR_IMAGE ?? 'opsreplay/monitor-test:dev',
    '--format',
    '{{.Id}}',
  ),
);

function temporaryTls() {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-monitor-image-tls-'));
  const config = join(directory, 'openssl.cnf');
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
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
  const result = run('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-config',
    config,
  ]);
  try {
    assert.equal(result.status, 0, result.stderr);
    return {
      cert: readFileSync(certPath),
      certPath,
      key: readFileSync(keyPath),
      close: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

process.once('exit', () => {
  for (const child of followers) child.kill();
  for (const id of containers) docker('rm', '--force', id);
  for (const volume of watchedVolumes.values()) docker('volume', 'rm', volume);
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

test('the Monitor runtime image includes the available Debian Perl security update', () => {
  const version = success(
    docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      monitorImage,
      '-c',
      "version=$(dpkg-query -W -f='${Version}' perl-base) && " +
        'dpkg --compare-versions "$version" ge "5.36.0-7+deb12u4" && printf "%s" "$version"',
    ),
  );
  assert.notEqual(version, '');
});

test('reference runtime contains only the private manifest and runtime, not test clients or credentials', () => {
  const bytes = success(
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', monitorImage, '/app/challenge.json'),
  );
  assert.deepEqual(JSON.parse(bytes), manifest);
  if (monitorImage !== clientImage) {
    success(
      docker(
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        monitorImage,
        '-ec',
        'test ! -e /app/client.cjs && test ! -e /app/capture-check.cjs',
      ),
    );
  }
  const [image] = JSON.parse(success(docker('image', 'inspect', monitorImage)));
  assert.equal(image.Config.User, 'node');
  assert.deepEqual(image.Config.Entrypoint, ['node', '/app/runtime.cjs']);
  assert.deepEqual(image.Config.Cmd, ['/app/challenge.json']);
  assert.equal(
    image.Config.Env.some((value) => /OPSREPLAY_MONITOR_(SECRET|TLS_KEY_B64)=/.test(value)),
    false,
  );
});

test('Linux capture reader rejects links, directories, and FIFOs with bounded reads', () => {
  success(
    docker(
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=8m',
      '--entrypoint',
      'node',
      clientImage,
      '/app/capture-check.cjs',
    ),
  );
});

async function fresh(t, waitForListeners = true, disabledService) {
  const volume = 'opsreplay-watched-' + randomUUID();
  success(docker('volume', 'create', volume));
  const id = success(
    docker(
      'create',
      '--name',
      'opsreplay-monitor-shop-' + randomUUID(),
      '--hostname',
      'storefront',
      '--network',
      'none',
      ...resourceFlags(challengeSettings),
      '--pids-limit',
      '128',
      '--security-opt',
      'no-new-privileges=true',
      '--mount',
      `type=volume,src=${volume},dst=/opsreplay/watched`,
      '--env',
      'OPSREPLAY_WATCHED_FILES=1',
      challengeImage,
    ),
  );
  watchedVolumes.set(id, volume);
  containers.add(id);
  t.after(() => {
    success(docker('rm', '--force', id));
    containers.delete(id);
    // Other after-hooks can still own Monitor mounts. Remove the volume only
    // after all containers in this test process have been removed.
  });
  if (disabledService) {
    const directory = mkdtempSync(join(tmpdir(), 'opsreplay-disabled-service-'));
    const config = join(directory, 'supervisord.conf');
    try {
      success(docker('cp', id + ':/etc/supervisor/supervisord.conf', config));
      const source = readFileSync(config, 'utf8');
      const section = `[program:${disabledService}]\n`;
      assert.ok(source.includes(section));
      writeFileSync(config, source.replace(section, section + 'autostart=false\n'));
      success(docker('cp', config, id + ':/etc/supervisor/supervisord.conf'));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  success(docker('start', id));
  if (waitForListeners)
    await eventually(() => exec(id, 'opsreplay-check-startup').status === 0, 'Shop listeners did not start', 30_000);
  return id;
}

function control(monitor, path = '/healthz', method = 'GET') {
  return JSON.parse(
    success(
      exec(
        monitor.id,
        'node',
        '-e',
        `const https = require('node:https');
const req = https.request({
  host: '127.0.0.1', port: 9443, path: process.argv[1], method: process.argv[2],
  ca: Buffer.from(process.env.OPSREPLAY_MONITOR_TLS_CERT_B64, 'base64'),
  headers: {Authorization: 'Bearer ' + process.env.OPSREPLAY_MONITOR_SECRET},
  timeout: 2000
}, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log(JSON.stringify({status: res.statusCode, body: JSON.parse(body)})));
});
req.on('error', () => process.exit(1));
req.on('timeout', () => req.destroy());
req.end();`,
        path,
        method,
      ),
    ),
  );
}

async function startingWithMissingService(t, service, port) {
  const shop = await fresh(t, false, service);
  await eventually(
    () => exec(shop, 'curl', '--silent', '--output', '/dev/null', 'http://127.0.0.1/').status === 0,
    'Proxy did not start with its planted fault',
  );
  const otherPorts = [80, 8080, 5432, 7681].filter((candidate) => candidate !== port);
  await eventually(
    () =>
      exec(
        shop,
        'python3',
        '-c',
        `import socket\nfor port in ${JSON.stringify(otherPorts)}:\n with socket.create_connection(("127.0.0.1", port), timeout=1): pass`,
      ).status === 0,
    'Unrelated service listeners did not start',
  );
  const startup = exec(shop, 'opsreplay-check-startup');
  assert.notEqual(startup.status, 0);
  assert.match(startup.stderr, new RegExp(`port ${port} is not ready`));
  const monitor = startMonitor(t, shop);
  await eventually(
    () => success(docker('logs', monitor.id)).includes('control_listening'),
    'Monitor control listener did not start',
  );
  assert.deepEqual(control(monitor), { status: 503, body: { status: 'starting' } });
  assert.equal(control(monitor, '/v1/start', 'POST').status, 409);
  assert.equal(
    monitor.all().some((record) => record.type === 'monitor_started'),
    false,
  );
  return { shop, monitor };
}

for (const [service, port] of [
  ['shop', 8080],
  ['postgres', 5432],
]) {
  test(
    `missing ${service} at launch cannot pass readiness or recover after the startup deadline`,
    { timeout: 60_000 },
    async (t) => {
      const { shop, monitor } = await startingWithMissingService(t, service, port);
      await eventually(
        () => control(monitor).body.status === 'failed',
        'Missing startup listener did not fail closed at the readiness deadline',
        35_000,
      );
      assert.deepEqual(control(monitor), { status: 503, body: { status: 'failed' } });
      const expectedError = '{"type":"monitor_error","code":"initial_state_failed"}\n';
      await eventually(
        () => monitor.errors() === expectedError,
        'Client did not report the expected startup rejection',
      );
      assert.equal(success(docker('wait', monitor.clientId)), '1');
      assert.deepEqual(monitor.all(expectedError), []);
      success(exec(shop, 'service', service, 'start'));
      await eventually(() => exec(shop, 'opsreplay-check-startup').status === 0, 'Late listener did not start');
      assert.deepEqual(control(monitor), { status: 503, body: { status: 'failed' } });
      assert.equal(control(monitor, '/v1/start', 'POST').status, 409);
    },
  );
}

test(
  'a delayed shop listener permits readiness only after startup prerequisites pass',
  { timeout: 60_000 },
  async (t) => {
    const { shop, monitor } = await startingWithMissingService(t, 'shop', 8080);
    success(exec(shop, 'service', 'shop', 'start'));
    await eventually(
      () => monitor.metrics().some((frame) => frame.counters.failedRequests > 0),
      'Delayed shop never became ready',
    );
    success(exec(shop, 'opsreplay-check-startup'));
    assert.deepEqual(control(monitor), { status: 200, body: { status: 'ready' } });
    await stopMonitor(monitor);
  },
);

function startMonitor(t, challenge, startTimeoutMs = 30_000) {
  const cleanup = [];
  t.after(() => {
    for (const close of cleanup.reverse()) close();
  });
  const tls = temporaryTls();
  cleanup.push(() => tls.close());
  const secret = randomBytes(32).toString('base64url');
  const id = success(
    docker(
      'run',
      '--detach',
      '--name',
      'opsreplay-monitor-test-' + randomUUID(),
      '--label',
      'opsreplay.test=monitor',
      '--network',
      'container:' + challenge,
      '--mount',
      `type=volume,src=${watchedVolumes.get(challenge)},dst=/opsreplay/watched,readonly`,
      ...resourceFlags(monitorSettings),
      '--security-opt',
      'no-new-privileges=true',
      '--pids-limit',
      '64',
      '--env',
      'OPSREPLAY_MONITOR_SECRET=' + secret,
      '--env',
      'OPSREPLAY_MONITOR_TLS_CERT_B64=' + tls.cert.toString('base64'),
      '--env',
      'OPSREPLAY_MONITOR_TLS_KEY_B64=' + tls.key.toString('base64'),
      monitorImage,
      '/app/challenge.json',
    ),
  );
  containers.add(id);
  cleanup.push(() => {
    success(docker('rm', '--force', id));
    containers.delete(id);
  });
  const clientId = success(
    docker(
      'run',
      '--detach',
      '--name',
      'opsreplay-monitor-client-' + randomUUID(),
      '--label',
      'opsreplay.test=monitor',
      '--network',
      'container:' + challenge,
      '--mount',
      `type=volume,src=${watchedVolumes.get(challenge)},dst=/opsreplay/watched,readonly`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--cpus',
      '0.25',
      '--memory',
      '64m',
      '--memory-swap',
      '64m',
      '--pids-limit',
      '32',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=4m',
      '--env',
      'OPSREPLAY_MONITOR_SECRET=' + secret,
      '--env',
      'OPSREPLAY_MONITOR_CA_B64=' + tls.cert.toString('base64'),
      '--env',
      'OPSREPLAY_MONITOR_CLIENT_START_TIMEOUT_MS=' + startTimeoutMs,
      '--entrypoint',
      'node',
      clientImage,
      '/app/client.cjs',
    ),
  );
  containers.add(clientId);
  cleanup.push(() => {
    success(docker('rm', '--force', clientId));
    containers.delete(clientId);
  });
  const records = [];
  let pending = '';
  let stderr = '';
  let parseError;
  const follow = spawn('docker', ['logs', '--follow', clientId], { stdio: ['ignore', 'pipe', 'pipe'] });
  followers.add(follow);
  cleanup.push(() => {
    follow.kill();
    followers.delete(follow);
  });
  follow.stdout.setEncoding('utf8');
  follow.stdout.on('data', (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        records.push(JSON.parse(line));
      } catch {
        parseError = 'Invalid monitor JSON';
      }
    }
    if (pending.length > 65536 || records.length > 2000) parseError = 'Monitor output exceeded test bounds';
  });
  follow.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-4096);
  });
  follow.on('error', (error) => {
    parseError = error.message;
  });
  const all = (expectedError = '') => {
    assert.equal(parseError, undefined);
    assert.equal(stderr, expectedError, stderr);
    return records;
  };
  return {
    id,
    clientId,
    certPath: tls.certPath,
    records,
    all,
    errors: () => stderr,
    metrics: () =>
      all()
        .filter((r) => r.payload?.type === 'metrics')
        .map((r) => r.payload),
    events: (signal) =>
      all()
        .filter((r) => r.payload?.type === 'timeline' && r.payload.event.signal === signal)
        .map((r) => r.payload.event),
  };
}

async function stopMonitor(monitor) {
  success(docker('kill', '--signal', 'TERM', monitor.clientId));
  const clientExit = success(docker('wait', monitor.clientId));
  if (clientExit !== '0')
    assert.fail(`Monitor client exited ${clientExit}:\n${success(docker('logs', monitor.clientId))}`);
  await eventually(() => monitor.all().some((r) => r.type === 'monitor_sealed'), 'No sealed measurement output');
  const captures = monitor
    .all()
    .filter((r) => r.type === 'capture_verified')
    .map((r) => r.capture);
  assert.ok(captures.length > 0);
  assert.equal(captures.at(-1).incomplete, false);
  assert.equal(captures.at(-1).metrics.at, monitor.all().find((r) => r.type === 'monitor_sealed').final.sample.at);
  success(docker('kill', '--signal', 'TERM', monitor.id));
  const monitorExit = success(docker('wait', monitor.id));
  if (monitorExit !== '0') assert.fail(`Monitor exited ${monitorExit}:\n${success(docker('logs', monitor.id))}`);
}

async function repaired(t, monitor, repair) {
  const previousSustaining = monitor.events('recovery_sustaining').length;
  await repair();
  await eventually(
    () => monitor.events('recovery_sustaining').length > previousSustaining,
    'Checkout did not start passing after repair',
  );
  assert.equal(monitor.events('recovered').length, 0, 'One passing check is not sustained recovery');
  try {
    await eventually(
      () => monitor.events('recovered').length === 1,
      'Checkout did not remain healthy for 60 seconds',
      90_000,
    );
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

test(
  'sidecar measures the real fault, safe reload, harmful restart, and reference recovery',
  { timeout: 180_000 },
  async (t) => {
    // ECS START orders container startup, not service readiness.
    const shop = await fresh(t, false);
    const monitor = startMonitor(t, shop);
    await eventually(
      () => monitor.metrics().some((m) => m.counters.failedRequests > 0),
      'Initial failures were not measured',
    );
    const [inspect] = JSON.parse(success(docker('inspect', monitor.id)));
    assert.equal(inspect.HostConfig.NetworkMode, 'container:' + shop);
    assert.equal(inspect.HostConfig.Privileged, false);
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspect.HostConfig.PidMode, '');
    assert.equal(inspect.HostConfig.CpuShares, monitorSettings.Cpu);
    assert.equal(inspect.HostConfig.Memory, monitorSettings.Memory * 1024 * 1024);
    assert.equal(inspect.HostConfig.Init, true);
    assert.ok(inspect.HostConfig.CapDrop.includes('ALL'));
    assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
    assert.equal(success(exec(monitor.id, 'id', '-u')), '1000');
    assert.notEqual(exec(monitor.id, 'touch', '/opsreplay/watched/monitor-write-test').status, 0);
    assert.notEqual(exec(monitor.id, 'touch', '/tmp/monitor-write-test').status, 0);
    success(exec(shop, 'test', '!', '-e', '/app/challenge.json'));
    const privateEnvironment = success(exec(shop, 'cat', '/proc/1/environ'));
    assert.equal(privateEnvironment.includes('OPSREPLAY_MONITOR_SECRET='), false);
    assert.equal(privateEnvironment.includes('OPSREPLAY_MONITOR_TLS_KEY_B64='), false);
    const processes = success(exec(shop, 'ps', '-eo', 'args'));
    assert.equal(processes.includes('/app/runtime.cjs'), false);
    success(exec(shop, 'test', '!', '-e', '/app/core.cjs'));
    success(docker('cp', monitor.certPath, shop + ':/tmp/monitor-ca.pem'));
    const unauthorized = exec(
      shop,
      'curl',
      '--silent',
      '--show-error',
      '--cacert',
      '/tmp/monitor-ca.pem',
      '--output',
      '/tmp/monitor-response',
      '--write-out',
      '%{http_code}',
      'https://127.0.0.1:9443/v1/frames?after=0',
    );
    assert.equal(success(unauthorized), '401');
    assert.deepEqual(JSON.parse(success(exec(shop, 'cat', '/tmp/monitor-response'))), {
      code: 'AUTH_FAILED',
      message: 'Monitor authentication failed.',
    });
    assert.notEqual(exec(shop, 'curl', '--silent', '--show-error', 'http://127.0.0.1:9443/healthz').status, 0);

    const trap = manifest.traps[0];
    success(exec(shop, 'sh', '-ec', trap.safeAlternative.commands[0]));
    assert.notEqual(exec(shop, 'sh', '-ec', trap.safeAlternative.commands[1]).status, 0);
    await delay(6000);
    assert.equal(monitor.events('outage_started').length, 0, 'Failed reload should preserve the listener');
    assert.notEqual(exec(shop, 'service', 'nginx', 'restart').status, 0);
    await eventually(() => monitor.events('outage_started').length === 1, 'Stopped proxy outage was not measured');
    assert.equal(success(docker('inspect', '--format', '{{.State.Status}}', monitor.id)), 'running');

    await repaired(t, monitor, async () => {
      success(
        docker(
          'cp',
          fileURLToPath(new URL('image/rootfs/etc/nginx/nginx.conf', challengePath)),
          shop + ':/etc/nginx/nginx.conf',
        ),
      );
      success(exec(shop, 'service', 'nginx', 'start'));
      await eventually(
        () => exec(shop, 'sh', '-ec', 'test -s /run/nginx.pid && kill -0 "$(cat /run/nginx.pid)"').status === 0,
        'nginx did not finish writing its PID before reload',
      );
      for (const command of manifest.referenceFix.commands) success(exec(shop, 'sh', '-ec', command));
    });
    assert.equal(monitor.events('outage_ended').length, 1);
    const count = Number(
      success(
        exec(
          shop,
          'runuser',
          '-u',
          'postgres',
          '--',
          'psql',
          '-X',
          '-d',
          'shop',
          '-At',
          '-c',
          'SELECT count(*) FROM orders',
        ),
      ),
    );
    assert.ok(count > 60 && count < 1000, `Unexpected test order count: ${count}`);
    const frames = monitor.all().filter((r) => r.sequence);
    assert.deepEqual(
      frames.map((r) => r.sequence),
      Array.from({ length: frames.length }, (_, i) => i + 1),
    );
    const output = JSON.stringify(monitor.all().filter((r) => r.type !== 'capture_verified'));
    for (const hidden of ['plantedFault', 'referenceFix', 'validators', 'proxy_pass', 'MONITOR_SECRET']) {
      assert.ok(!output.includes(hidden), `Monitor public frames included ${hidden}`);
    }
    // Captures intentionally contain learner-visible config, including proxy_pass.
    // They must never contain private manifest metadata or Monitor credentials.
    const captures = JSON.stringify(monitor.all().filter((r) => r.type === 'capture_verified'));
    for (const hidden of ['plantedFault', 'referenceFix', 'validators', 'MONITOR_SECRET'])
      assert.ok(!captures.includes(hidden));
    assert.ok(captures.includes('proxy_pass'), 'Changed allowlisted config was not captured');
    await stopMonitor(monitor);

    const alreadyHealthy = startMonitor(t, shop, 5_000);
    assert.equal(success(docker('wait', alreadyHealthy.clientId)), '1');
    await eventually(
      () => alreadyHealthy.errors().includes('initial_state_failed'),
      'Healthy image should fail initial incident verification',
    );
  },
);

test(
  'sidecar accepts moving the application listener as a real alternative repair',
  { timeout: 150_000 },
  async (t) => {
    const shop = await fresh(t);
    const monitor = startMonitor(t, shop);
    await eventually(
      () => monitor.metrics().some((m) => m.counters.failedRequests > 0),
      'Initial failures were not measured',
    );
    await repaired(t, monitor, async () => {
      success(exec(shop, 'sed', '-i', 's/127.0.0.1:8080/127.0.0.1:8081/', '/etc/shop/gunicorn.conf.py'));
      success(exec(shop, 'service', 'shop', 'restart'));
    });
    assert.equal(monitor.events('outage_started').length, 0, 'Changing the app listener does not stop the proxy');
    await stopMonitor(monitor);
  },
);
