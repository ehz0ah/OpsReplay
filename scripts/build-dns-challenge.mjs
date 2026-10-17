import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const tag = `opsreplay/challenge-dns-base:${randomUUID()}`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || 'Challenge build failed.');
  return result.stdout.trim();
}
try {
  docker([
    'build',
    '--platform',
    'linux/amd64',
    '--provenance=false',
    '-t',
    tag,
    'content/challenges/wrong-upstream-port/image',
  ]);
  const digest = docker(['image', 'inspect', tag, '--format', '{{.Id}}']);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Shared image identity is invalid.');
  docker([
    'build',
    '--platform',
    'linux/amd64',
    '--provenance=false',
    '--build-arg',
    `CHALLENGE_BASE=${tag}`,
    '-t',
    'opsreplay/challenge-stale-dns-record:dev',
    'content/challenges/stale-dns-record/image',
  ]);
} finally {
  const cleanup = spawnSync('docker', ['image', 'rm', tag], { encoding: 'utf8', timeout: 30_000 });
  if (cleanup.status !== 0) {
    console.error(`Could not remove temporary base tag ${tag}.`);
    process.exitCode = 1;
  }
}
