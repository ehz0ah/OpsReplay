import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referenceImageManifest } from './reference-image-manifest.mjs';

const digest = `sha256:${'a'.repeat(64)}`;

test('reference manifest is copied from the exact loaded Linux image without running it', () => {
  const calls = [];
  const manifest = { id: 'wrong-upstream-port', status: 'draft' };
  const run = (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'image' && args[1] === 'inspect')
      return JSON.stringify([{ Id: digest, Architecture: 'amd64', Os: 'linux' }]);
    return '';
  };
  assert.deepEqual(
    referenceImageManifest(digest, {
      run,
      read: () => JSON.stringify(manifest),
      stat: () => ({ size: 100 }),
    }),
    manifest,
  );
  assert.deepEqual(
    calls.map(([, args]) => args[0]),
    ['image', 'create', 'cp', 'rm'],
  );
  const create = calls[1][1];
  assert.ok(create.includes('--network'));
  assert.ok(create.includes('none'));
  assert.ok(create.includes('--entrypoint'));
  assert.equal(create.at(-1), digest);
  assert.match(calls[2][1][1], /:\/app\/challenge\.json$/);
});

test('reference manifest rejects a wrong image identity, platform, or oversized file', () => {
  const options = (inspection, size = 100) => ({
    run: (_command, args) => {
      if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([inspection]);
      return '';
    },
    read: () => '{}',
    stat: () => ({ size }),
  });
  assert.throws(() => referenceImageManifest('invalid', options({})), /Invalid reference image identity/);
  assert.throws(
    () => referenceImageManifest(digest, options({ Id: digest, Architecture: 'arm64', Os: 'linux' })),
    /identity or platform/,
  );
  assert.throws(
    () => referenceImageManifest(digest, options({ Id: digest, Architecture: 'amd64', Os: 'linux' }, 256 * 1024 + 1)),
    /too large/,
  );
});

test('temporary inspection container is removed when copying or parsing fails', () => {
  const calls = [];
  assert.throws(() =>
    referenceImageManifest(digest, {
      run: (_command, args) => {
        calls.push(args);
        if (args[0] === 'image' && args[1] === 'inspect')
          return JSON.stringify([{ Id: digest, Architecture: 'amd64', Os: 'linux' }]);
        if (args[0] === 'cp') throw new Error('copy failed');
        return '';
      },
      read: () => '{}',
      stat: () => ({ size: 1 }),
    }),
  );
  assert.equal(calls.at(-1)[0], 'rm');
});
