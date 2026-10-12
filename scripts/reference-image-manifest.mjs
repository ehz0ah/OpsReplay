import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function boundedRun(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, AWS_PAGER: '' },
  });
  // Do not echo AWS output, environment values, or private content on failure.
  if (result.error || result.status !== 0) throw new Error(`${command} inspection failed.`);
  return result.stdout.trim();
}

/** Reads the loaded, tested image by configuration identity without running it. */
export function referenceImageManifest(configDigest, { run = boundedRun, read = readFileSync, stat = statSync } = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest)) throw new Error('Invalid reference image identity.');
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-reference-image-'));
  const name = `opsreplay-reference-inspect-${randomUUID()}`;
  let created = false;
  try {
    const inspection = JSON.parse(run('docker', ['image', 'inspect', configDigest]));
    if (
      inspection.length !== 1 ||
      inspection[0]?.Id !== configDigest ||
      inspection[0]?.Architecture !== 'amd64' ||
      inspection[0]?.Os !== 'linux'
    ) {
      throw new Error('Reference image identity or platform does not match.');
    }
    run('docker', ['create', '--name', name, '--network', 'none', '--entrypoint', '/bin/false', configDigest]);
    created = true;
    const path = join(directory, 'challenge.json');
    run('docker', ['cp', `${name}:/app/challenge.json`, path]);
    if (stat(path).size > 256 * 1024) throw new Error('Embedded reference manifest is too large.');
    return JSON.parse(read(path, 'utf8'));
  } finally {
    try {
      if (created) run('docker', ['rm', name]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
