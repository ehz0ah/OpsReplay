import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkpointImages,
  checkpointTag,
  parseBatchGetImage,
  parseDockerImageInspect,
  publishCheckpointImages,
} from './publish-checkpoint-images.mjs';

const commitSha = 'a'.repeat(40);
const digest = (character) => `sha256:${character.repeat(64)}`;
const localConfigDigests = Object.fromEntries(
  checkpointImages.map((image, index) => [image.localImage, digest(String.fromCharCode(97 + index))]),
);
const existing = Object.fromEntries(
  checkpointImages.map((image, index) => [
    image.repository,
    { digest: digest(String(index + 1)), configDigest: localConfigDigests[image.localImage] },
  ]),
);

function temporaryOutput() {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-checkpoint-images-'));
  return {
    directory,
    manifest: join(directory, 'artifacts', 'checkpoint-images.json'),
    summary: join(directory, 'summary.md'),
  };
}

function environment(output, overrides = {}) {
  return {
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: commitSha,
    AWS_REGION: 'ap-southeast-1',
    CHECKPOINT_IMAGE_MANIFEST: output.manifest,
    GITHUB_STEP_SUMMARY: output.summary,
    ...overrides,
  };
}

function batchResponse(repository, values = existing) {
  const image = values[repository];
  return image
    ? JSON.stringify({
        images: [
          {
            imageId: { imageDigest: image.digest },
            imageManifest: JSON.stringify({
              schemaVersion: 2,
              config: { digest: image.configDigest },
              layers: [],
            }),
          },
        ],
        failures: [],
      })
    : JSON.stringify({ images: [], failures: [{ failureCode: 'ImageNotFound' }] });
}

function inspectLocalImage(command, args) {
  if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
    const localImage = args.at(-1);
    assert.ok(localImage in localConfigDigests);
    return JSON.stringify([
      {
        Id: digest('f'),
        Descriptor: { annotations: { 'config.digest': localConfigDigests[localImage] } },
      },
    ]);
  }
  return null;
}

test('checkpoint tags bind the complete commit SHA to tested image content', () => {
  assert.equal(checkpointTag(commitSha, digest('a')), `git-${commitSha}-${'a'.repeat(64)}`);
  assert.notEqual(checkpointTag(commitSha, digest('a')), checkpointTag(commitSha, digest('b')));
  assert.throws(() => checkpointTag('ABC', digest('a')), /40-character lowercase commit SHA/);
  assert.throws(() => checkpointTag(commitSha, 'sha256:short'), /configuration digest is missing or invalid/);
});

test('batch image responses distinguish a digest from a missing image', () => {
  assert.deepEqual(parseBatchGetImage(batchResponse('opsreplay-gateway'), 'opsreplay-gateway', 'tag'), {
    digest: digest('1'),
    configDigest: digest('a'),
  });
  assert.equal(parseBatchGetImage(batchResponse('missing'), 'missing', 'tag'), null);
  assert.throws(
    () =>
      parseBatchGetImage(
        JSON.stringify({ images: [], failures: [{ failureCode: 'RepositoryNotFound' }] }),
        'missing',
        'tag',
      ),
    /RepositoryNotFound/,
  );
  assert.throws(
    () =>
      parseBatchGetImage(
        JSON.stringify({ images: [{ imageId: { imageDigest: digest('1') } }], failures: [] }),
        'opsreplay-gateway',
        'tag',
      ),
    /invalid image manifest/,
  );
});

test('Docker image metadata resolves configuration digests across image stores', () => {
  const configDigest = digest('a');
  assert.equal(
    parseDockerImageInspect(
      JSON.stringify([{ Id: digest('f'), Descriptor: { annotations: { 'config.digest': configDigest } } }]),
      'current-engine',
    ),
    configDigest,
  );
  assert.equal(parseDockerImageInspect(JSON.stringify([{ Id: configDigest }]), 'legacy-engine'), configDigest);
  assert.throws(() => parseDockerImageInspect('not-json', 'invalid'), /invalid image metadata/);
  assert.throws(() => parseDockerImageInspect(JSON.stringify([]), 'missing'), /unexpected image metadata/);
  assert.throws(
    () =>
      parseDockerImageInspect(
        JSON.stringify([{ Id: configDigest, Descriptor: { annotations: { 'config.digest': 'invalid' } } }]),
        'invalid-digest',
      ),
    /invalid image configuration digest/,
  );
});

test('an existing immutable commit tag is reused without a Docker login or push', () => {
  const output = temporaryOutput();
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === 'aws' && args[0] === 'sts') return '123456789012';
    const localImage = inspectLocalImage(command, args);
    if (localImage !== null) return localImage;
    if (command === 'aws' && args[1] === 'batch-get-image') {
      return batchResponse(args[args.indexOf('--repository-name') + 1]);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  try {
    const { manifest } = publishCheckpointImages({ env: environment(output), run });
    assert.equal(
      calls.filter(([command, args]) => command === 'docker' && ['login', 'tag', 'push'].includes(args[0])).length,
      0,
    );
    assert.equal(
      calls.filter(([command, args]) => command === 'docker' && args[0] === 'image' && args[1] === 'inspect').length,
      checkpointImages.length,
    );
    for (const image of checkpointImages) {
      const call = calls.find(
        ([command, args]) =>
          command === 'aws' &&
          args[1] === 'batch-get-image' &&
          args[args.indexOf('--repository-name') + 1] === image.repository,
      );
      assert.ok(call);
      assert.equal(
        call[1][call[1].indexOf('--image-ids') + 1],
        `imageTag=${checkpointTag(commitSha, localConfigDigests[image.localImage])}`,
      );
      assert.deepEqual(call[1].slice(call[1].indexOf('--accepted-media-types') + 1, -2), [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
      ]);
    }
    assert.equal(manifest.images.gateway.digest, digest('1'));
    assert.equal(manifest.images.gateway.tag, `git-${commitSha}-${'a'.repeat(64)}`);
    assert.equal(JSON.parse(readFileSync(output.manifest, 'utf8')).commitSha, commitSha);
    assert.match(readFileSync(output.summary, 'utf8'), /Checkpoint image publication/);
  } finally {
    rmSync(output.directory, { recursive: true, force: true });
  }
});

test('an existing immutable tag with different tested content fails before login or push', () => {
  const output = temporaryOutput();
  const calls = [];
  const values = {
    ...existing,
    'opsreplay-gateway': { ...existing['opsreplay-gateway'], configDigest: digest('f') },
  };
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === 'aws' && args[0] === 'sts') return '123456789012';
    const localImage = inspectLocalImage(command, args);
    if (localImage !== null) return localImage;
    if (command === 'aws' && args[1] === 'batch-get-image') {
      return batchResponse(args[args.indexOf('--repository-name') + 1], values);
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  try {
    assert.throws(
      () => publishCheckpointImages({ env: environment(output), run }),
      /does not match the tested local image configuration/,
    );
    assert.equal(
      calls.filter(([command, args]) => command === 'docker' && ['login', 'tag', 'push'].includes(args[0])).length,
      0,
    );
  } finally {
    rmSync(output.directory, { recursive: true, force: true });
  }
});

test('only missing images are authenticated, pushed, and resolved again', () => {
  const output = temporaryOutput();
  const calls = [];
  const values = { ...existing };
  delete values['opsreplay/monitor'];
  let monitorPushed = false;
  const run = (command, args, options = {}) => {
    calls.push([command, args, options]);
    if (command === 'aws' && args[0] === 'sts') return '123456789012';
    if (command === 'aws' && args[1] === 'get-login-password') return 'temporary-password';
    const localImage = inspectLocalImage(command, args);
    if (localImage !== null) return localImage;
    if (command === 'aws' && args[1] === 'batch-get-image') {
      const repository = args[args.indexOf('--repository-name') + 1];
      if (repository === 'opsreplay/monitor' && monitorPushed) {
        values[repository] = { digest: digest('4'), configDigest: localConfigDigests['opsreplay/monitor:dev'] };
      }
      return batchResponse(repository, values);
    }
    if (command === 'docker' && args[0] === 'login') {
      assert.equal(options.input, 'temporary-password\n');
      assert.equal(args.includes('temporary-password'), false);
      return '';
    }
    if (command === 'docker' && args[0] === 'tag') return '';
    if (command === 'docker' && args[0] === 'push') {
      monitorPushed = true;
      return '';
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  try {
    const { manifest } = publishCheckpointImages({ env: environment(output), run });
    assert.equal(manifest.images.monitor.digest, digest('4'));
    assert.equal(calls.filter(([command, args]) => command === 'docker' && args[0] === 'push').length, 1);
    assert.match(
      calls.find(([command, args]) => command === 'docker' && args[0] === 'push')[1][1],
      /opsreplay\/monitor/,
    );
  } finally {
    rmSync(output.directory, { recursive: true, force: true });
  }
});

test('publication rejects a non-main ref before using AWS', () => {
  const output = temporaryOutput();
  try {
    assert.throws(
      () => publishCheckpointImages({ env: environment(output, { GITHUB_REF: 'refs/heads/feature' }), run: () => '' }),
      /only from main/,
    );
  } finally {
    rmSync(output.directory, { recursive: true, force: true });
  }
});
