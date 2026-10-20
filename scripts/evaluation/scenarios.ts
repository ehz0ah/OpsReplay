import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { distribution, integer, reserveReport } from './report.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const commands = {
  'wrong-upstream-port': [
    {
      name: 'challenge:test',
      files: [
        'content/challenges/wrong-upstream-port/image.test.mjs',
        'content/challenges/wrong-upstream-port/recording-wire.test.mjs',
        'content/challenges/wrong-upstream-port/proposals-wire.test.mjs',
      ],
    },
    { name: 'monitor:reference:image:test', files: ['apps/monitor/test/image.test.mjs'] },
  ],
  'stale-dns-record': [
    { name: 'challenge:dns:test', files: ['content/challenges/stale-dns-record/image.test.mjs'] },
    { name: 'monitor:dns:image:test', files: ['apps/monitor/test/image.test.mjs'] },
  ],
} as const;
export async function boundedProcess(args: string[], timeoutMs: number, environment = process.env) {
  return new Promise<{ passed: boolean; reason: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let bytes = 0,
      killed: string | null = null;
    const kill = (reason: string) => {
      if (killed) return;
      killed = reason;
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      forced = setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 2000);
    };
    let forced: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) kill('output_limit');
      });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (forced) clearTimeout(forced);
      resolve({ passed: code === 0 && !killed, reason: killed ?? (code === 0 ? null : 'suite_failed') });
    });
  });
}
export async function repeatScenarios(challenge: keyof typeof commands, repeats: number, path: string) {
  if (!Object.hasOwn(commands, challenge)) throw new Error('Select an implemented Challenge.');
  integer(repeats, 1, 20);
  const manifest = await readFile(new URL(`../../content/challenges/${challenge}/challenge.json`, import.meta.url));
  const images =
    challenge === 'stale-dns-record'
      ? ['opsreplay/challenge-stale-dns-record:dev', 'opsreplay/monitor-stale-dns:dev', 'opsreplay/monitor-test:dev']
      : [
          'opsreplay/challenge-wrong-upstream-port:dev',
          'opsreplay/monitor-reference:dev',
          'opsreplay/monitor-test:dev',
        ];
  const imageIds = Object.fromEntries(
    images.map((image) => [
      image,
      execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
        encoding: 'utf8',
        timeout: 10000,
      }).trim(),
    ]),
  );
  const results = [];
  const environment = {
    ...process.env,
    OPSREPLAY_TEST_CHALLENGE: challenge,
    OPSREPLAY_CHALLENGE_IMAGE: imageIds[images[0]!],
    OPSREPLAY_DNS_CHALLENGE_IMAGE: imageIds[images[0]!],
    OPSREPLAY_MONITOR_IMAGE: imageIds[images[1]!],
    OPSREPLAY_MONITOR_CLIENT_IMAGE: imageIds[images[2]!],
  };
  const write = await reserveReport(path);
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const command of commands[challenge]) {
      const started = performance.now();
      const result = await boundedProcess(['--import', 'tsx', '--test', ...command.files], 15 * 60_000, environment);
      results.push({ repeat, suite: command.name, durationMs: performance.now() - started, ...result });
      if (!result.passed) break;
    }
    if (results.some((r) => !r.passed)) break;
  }
  // Images must stay fixed throughout a repeated run.
  const unchanged = images.every(
    (image) =>
      execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
        encoding: 'utf8',
        timeout: 10000,
      }).trim() === imageIds[image],
  );
  const report = {
    schemaVersion: 1,
    kind: 'local-scenario-repeats',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    challenge,
    version: JSON.parse(manifest.toString()).version,
    manifestSha256: createHash('sha256').update(manifest).digest('hex'),
    imageIds,
    requestedRepeats: repeats,
    unchangedImages: unchanged,
    passed: unchanged && results.length === repeats * 2 && results.every((r) => r.passed),
    suiteDurationMs: distribution(results.map((r) => r.durationMs)),
    results,
    limits: [
      'Local Docker, not Fargate.',
      'Suite duration is not time to learner recovery.',
      'Forced process termination can leave test containers. Inspect named test resources after interruption.',
    ],
  };
  await write(report);
  return report.passed;
}
