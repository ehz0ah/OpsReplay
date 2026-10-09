import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  checkpointImages,
  checkpointTag,
  parseBatchGetImage,
  parseDockerArchiveManifest,
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
const expectedConfigDigests = new Map([
  ['gateway', digest('a')],
  ['monitor', digest('b')],
  ['challenge', digest('c')],
]);

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
    CHECKPOINT_IMAGE_BUNDLE: join(output.directory, 'checkpoint-images.tar'),
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

function archiveManifest(configDigests = localConfigDigests, configPath = (value) => `blobs/sha256/${value.slice(7)}`) {
  return JSON.stringify(
    checkpointImages.map((image) => ({
      Config: configPath(configDigests[image.localImage]),
      RepoTags: [image.localImage],
      Layers: [],
    })),
  );
}

function inspectImageBundle(command, args) {
  if (command === 'tar' && args[0] === '-xOf' && args.at(-1) === 'manifest.json') return archiveManifest();
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

test('Docker archive metadata resolves configuration digests across archive formats', () => {
  assert.deepEqual(parseDockerArchiveManifest(archiveManifest()), expectedConfigDigests);
  assert.deepEqual(
    parseDockerArchiveManifest(archiveManifest(localConfigDigests, (value) => `${value.slice(7)}.json`)),
    expectedConfigDigests,
  );
  assert.throws(() => parseDockerArchiveManifest('not-json'), /invalid manifest/);
  assert.throws(() => parseDockerArchiveManifest(JSON.stringify([])), /exactly one/);
  const duplicate = JSON.parse(archiveManifest());
  duplicate.push(duplicate[0]);
  assert.throws(() => parseDockerArchiveManifest(JSON.stringify(duplicate)), /exactly one/);
  assert.throws(
    () =>
      parseDockerArchiveManifest(
        archiveManifest({ ...localConfigDigests, 'opsreplay/gateway-recording:dev': 'sha256:invalid' }),
      ),
    /invalid configuration digest/,
  );
});

test('an invalid image archive fails before any AWS request', () => {
  const output = temporaryOutput();
  const calls = [];
  try {
    assert.throws(
      () =>
        publishCheckpointImages({
          env: environment(output),
          run: (command, args) => {
            calls.push([command, args]);
            if (command === 'tar') return '[]';
            throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
          },
        }),
      /exactly one/,
    );
    assert.deepEqual(
      calls.map(([command]) => command),
      ['tar'],
    );
  } finally {
    rmSync(output.directory, { recursive: true, force: true });
  }
});

test('an existing immutable commit tag is reused without a Docker login or push', () => {
  const output = temporaryOutput();
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    const bundle = inspectImageBundle(command, args);
    if (bundle !== null) return bundle;
    if (command === 'aws' && args[0] === 'sts') return '123456789012';
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
    assert.equal(calls.filter(([command]) => command === 'tar').length, 1);
    assert.deepEqual(calls.find(([command]) => command === 'tar')?.[1], [
      '-xOf',
      environment(output).CHECKPOINT_IMAGE_BUNDLE,
      'manifest.json',
    ]);
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
    const bundle = inspectImageBundle(command, args);
    if (bundle !== null) return bundle;
    if (command === 'aws' && args[0] === 'sts') return '123456789012';
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
    const bundle = inspectImageBundle(command, args);
    if (bundle !== null) return bundle;
    if (command === 'aws' && args[0] === 'sts') return '123456789012';
    if (command === 'aws' && args[1] === 'get-login-password') return 'temporary-password';
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
