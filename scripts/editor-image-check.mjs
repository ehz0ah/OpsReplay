import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const script = readFileSync(new URL('./editor-compatibility.py', import.meta.url), 'utf8');

export function verifyEditorCompatibility(image, run = execFileSync) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Editor check requires an exact image ID.');
  const name = `opsreplay-editor-check-${randomUUID()}`;
  let output;
  let failure;
  try {
    output = run(
      'docker',
      [
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--label',
        'opsreplay.test=editor-compatibility',
        '--platform',
        'linux/amd64',
        '--interactive',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges=true',
        '--cpus',
        '1',
        '--memory',
        '512m',
        '--memory-swap',
        '512m',
        '--pids-limit',
        '32',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=32m',
        '--entrypoint',
        'python3',
        image,
        '-',
      ],
      { input: script, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    failure = error;
  }
  try {
    run('docker', ['rm', '--force', name], { encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    if (!error.stderr?.toString().includes('No such container'))
      failure = failure ? new AggregateError([failure, error], 'Editor check and cleanup failed') : error;
  }
  if (failure) throw failure;
  const result = JSON.parse(output);
  if (
    result?.editingAliases !== 3 ||
    result.validSwapRecovery !== true ||
    result.packageVersion !== '2:9.0.1378-2+deb12u2+opsreplay1' ||
    result.packageHashesVerified !== true ||
    result.defaultEditor !== 'nano'
  )
    throw new Error('Editor compatibility report is incomplete.');
  return result;
}
