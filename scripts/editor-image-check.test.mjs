import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyEditorCompatibility } from './editor-image-check.mjs';

const image = 'sha256:' + 'a'.repeat(64);
const report = {
  editingAliases: 3,
  validSwapRecovery: true,
  packageVersion: '2:9.2.0858-1+opsreplay1',
  packageHashesVerified: true,
  defaultEditor: 'nano',
};

test('editor check uses a pinned isolated image and cleans only its own container', () => {
  const calls = [];
  const result = verifyEditorCompatibility(image, (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === 'run' ? JSON.stringify(report) : '';
  });
  assert.deepEqual(result, report);
  assert.equal(calls.length, 2);
  const start = calls[0];
  assert.equal(start.command, 'docker');
  assert.equal(start.args[start.args.indexOf('--network') + 1], 'none');
  assert.equal(start.args[start.args.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(start.args.includes('--read-only'));
  assert.ok(start.args.includes('--pull=never'));
  assert.equal(start.args[start.args.indexOf('--entrypoint') + 1], 'python3');
  assert.deepEqual(start.args.slice(-2), [image, '-']);
  assert.equal(start.options.timeout, 45000);
  assert.equal(start.options.encoding, 'utf8');
  assert.match(start.options.input, /No external samples/);
  const name = start.args[start.args.indexOf('--name') + 1];
  assert.match(name, /^opsreplay-editor-check-[a-f0-9-]+$/);
  assert.deepEqual(calls[1].args, ['rm', '--force', name]);
});

test('editor check rejects a mutable tag before requesting any process', () => {
  let calls = 0;
  assert.throws(
    () =>
      verifyEditorCompatibility('opsreplay/challenge:dev', () => {
        calls++;
      }),
    /exact image ID/,
  );
  assert.equal(calls, 0);
});

test('editor execution failure remains a failure after cleanup succeeds', () => {
  const failure = new Error('Editor check timed out.');
  let cleaned = false;
  assert.throws(
    () =>
      verifyEditorCompatibility(image, (_command, args) => {
        if (args[0] === 'run') throw failure;
        cleaned = true;
        return '';
      }),
    (error) => error === failure,
  );
  assert.equal(cleaned, true);
});

test('an already removed test container does not replace the execution failure', () => {
  const failure = new Error('Editor exited unsuccessfully.');
  assert.throws(
    () =>
      verifyEditorCompatibility(image, (_command, args) => {
        if (args[0] === 'run') throw failure;
        throw Object.assign(new Error('Missing container.'), { stderr: 'No such container: owned-test' });
      }),
    (error) => error === failure,
  );
});

test('cleanup failure cannot count a successful editor result as passed', () => {
  const failure = new Error('Cleanup failed.');
  assert.throws(
    () =>
      verifyEditorCompatibility(image, (_command, args) => {
        if (args[0] === 'run') return JSON.stringify(report);
        throw failure;
      }),
    (error) => error === failure,
  );
});

test('both execution and cleanup failures remain available to the caller', () => {
  const failure = new Error('Editor failed.');
  const cleanup = new Error('Cleanup failed.');
  assert.throws(
    () =>
      verifyEditorCompatibility(image, (_command, args) => {
        throw args[0] === 'run' ? failure : cleanup;
      }),
    (error) => error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === cleanup,
  );
});

test('invalid editor report is rejected after cleanup', () => {
  let cleaned = false;
  assert.throws(() =>
    verifyEditorCompatibility(image, (_command, args) => {
      if (args[0] === 'run') return 'invalid JSON';
      cleaned = true;
      return '';
    }),
  );
  assert.equal(cleaned, true);
});

test('incomplete reports cannot count missing compatibility checks as passed', () => {
  for (const result of [null, {}, { ...report, validSwapRecovery: false }, { ...report, packageVersion: 'other' }]) {
    assert.throws(
      () => verifyEditorCompatibility(image, (_command, args) => (args[0] === 'run' ? JSON.stringify(result) : '')),
      /report is incomplete/,
    );
  }
});
