import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
test('confirmed proposals preserve real shell input and do not resend delivery tokens', () => {
  const run = (cmd, args, extra = {}) => {
    const value = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30000, ...extra });
    assert.equal(value.status, 0, value.error?.message ?? value.stdout + value.stderr);
    return value.stdout.trim();
  };
  const script = fileURLToPath(new URL('./run-local.sh', import.meta.url));
  const id = run('sh', [script, 'opsreplay-proposal-' + randomUUID()]);
  try {
    run('docker', ['exec', '-i', id, 'python3', '-'], {
      input: readFileSync(new URL('./proposals.test.py', import.meta.url), 'utf8'),
    });
  } finally {
    run('docker', ['rm', '-f', id]);
  }
});
