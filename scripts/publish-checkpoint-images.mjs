import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const checkpointImages = Object.freeze([
  Object.freeze({
    name: 'gateway',
    repository: 'opsreplay-gateway',
    localImage: 'opsreplay/gateway-recording:dev',
  }),
  Object.freeze({
    name: 'monitor',
    repository: 'opsreplay/monitor',
    localImage: 'opsreplay/monitor:dev',
  }),
  Object.freeze({
    name: 'challenge',
    repository: 'opsreplay/challenge-wrong-upstream-port',
    localImage: 'opsreplay/challenge-wrong-upstream-port:dev',
  }),
]);

const commitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const accountPattern = /^[0-9]{12}$/;
const regionPattern = /^[a-z]{2}(?:-gov)?-[a-z]+-[0-9]$/;

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.trim();
}

export function checkpointTag(commitSha, configDigest) {
  if (!commitPattern.test(commitSha)) throw new Error('GITHUB_SHA must be a 40-character lowercase commit SHA.');
  if (!digestPattern.test(configDigest)) throw new Error('Image configuration digest is missing or invalid.');
  return `git-${commitSha}-${configDigest.slice('sha256:'.length)}`;
}

export function parseBatchGetImage(value, repository, tag) {
  let response;
  try {
    response = JSON.parse(value);
  } catch {
    throw new Error(`ECR returned invalid JSON for ${repository}:${tag}.`);
  }
  const images = Array.isArray(response.images) ? response.images : [];
  const failures = Array.isArray(response.failures) ? response.failures : [];
  if (images.length === 1 && failures.length === 0) {
    const digest = images[0]?.imageId?.imageDigest;
    if (!digestPattern.test(digest)) throw new Error(`ECR returned an invalid digest for ${repository}:${tag}.`);
    let manifest;
    try {
      manifest = JSON.parse(images[0]?.imageManifest);
    } catch {
      throw new Error(`ECR returned an invalid image manifest for ${repository}:${tag}.`);
    }
    const configDigest = manifest?.config?.digest;
    if (!digestPattern.test(configDigest)) {
      throw new Error(`ECR returned an invalid image configuration digest for ${repository}:${tag}.`);
    }
    return { digest, configDigest };
  }
  if (images.length === 0 && failures.length === 1 && failures[0]?.failureCode === 'ImageNotFound') return null;
  const codes = failures.map((failure) => failure?.failureCode ?? 'Unknown').join(', ');
  throw new Error(`ECR could not resolve ${repository}:${tag}. Failure codes: ${codes || 'unexpected response'}.`);
}

export function parseDockerArchiveManifest(value) {
  let response;
  try {
    response = JSON.parse(value);
  } catch {
    throw new Error('The Docker image archive contains an invalid manifest.');
  }
  if (!Array.isArray(response)) {
    throw new Error('The Docker image archive contains an invalid manifest.');
  }

  const configDigests = new Map();
  for (const image of checkpointImages) {
    const matchingEntries = response.filter(
      (entry) => Array.isArray(entry?.RepoTags) && entry.RepoTags.includes(image.localImage),
    );
    if (matchingEntries.length !== 1) {
      throw new Error(`The Docker image archive must contain exactly one ${image.localImage} image.`);
    }
    const configPath = matchingEntries[0]?.Config;
    const match =
      typeof configPath === 'string'
        ? /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/.exec(configPath)
        : null;
    const configDigest = match ? `sha256:${match[1] ?? match[2]}` : '';
    if (!digestPattern.test(configDigest)) {
      throw new Error(`The Docker image archive contains an invalid configuration digest for ${image.localImage}.`);
    }
    configDigests.set(image.name, configDigest);
  }
  return configDigests;
}

function batchGetImage(run, region, repository, tag) {
  return parseBatchGetImage(
    run('aws', [
      'ecr',
      'batch-get-image',
      '--region',
      region,
      '--repository-name',
      repository,
      '--image-ids',
      `imageTag=${tag}`,
      '--accepted-media-types',
      'application/vnd.docker.distribution.manifest.v2+json',
      'application/vnd.oci.image.manifest.v1+json',
      '--output',
      'json',
    ]),
    repository,
    tag,
  );
}

function writeSummary(path, manifest) {
  const rows = Object.entries(manifest.images)
    .map(([name, image]) => `| ${name} | \`${image.repository}\` | \`${image.digest}\` |`)
    .join('\n');
  appendFileSync(
    path,
    `### Checkpoint image publication\n\nCommit: \`${manifest.commitSha}\`\n\n| Image | Repository | Digest |\n| --- | --- | --- |\n${rows}\n`,
  );
}

export function publishCheckpointImages({ env = process.env, run = defaultRun } = {}) {
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('Checkpoint images can be published only from main.');
  const commitSha = env.GITHUB_SHA ?? '';
  if (!commitPattern.test(commitSha)) throw new Error('GITHUB_SHA must be a 40-character lowercase commit SHA.');
  const region = env.AWS_REGION ?? '';
  if (!regionPattern.test(region)) throw new Error('AWS_REGION is missing or invalid.');

  const bundlePath = resolve(env.CHECKPOINT_IMAGE_BUNDLE ?? 'artifacts/checkpoint-images.tar');
  const localConfigDigests = parseDockerArchiveManifest(run('tar', ['-xOf', bundlePath, 'manifest.json']));
  const account = run('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text']);
  if (!accountPattern.test(account)) throw new Error('AWS STS returned an invalid account ID.');
  const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
  const resolved = new Map();
  for (const image of checkpointImages) {
    const tag = checkpointTag(commitSha, localConfigDigests.get(image.name));
    const remote = batchGetImage(run, region, image.repository, tag);
    if (remote !== null && remote.configDigest !== localConfigDigests.get(image.name)) {
      throw new Error(
        `Existing immutable image ${image.repository}:${tag} does not match the tested local image configuration.`,
      );
    }
    resolved.set(image.name, remote);
  }

  const missing = checkpointImages.filter((image) => resolved.get(image.name) === null);
  if (missing.length > 0) {
    const password = run('aws', ['ecr', 'get-login-password', '--region', region]);
    run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { input: `${password}\n` });
    for (const image of missing) {
      const tag = checkpointTag(commitSha, localConfigDigests.get(image.name));
      const remoteImage = `${registry}/${image.repository}:${tag}`;
      run('docker', ['tag', image.localImage, remoteImage]);
      run('docker', ['push', remoteImage]);
      const remote = batchGetImage(run, region, image.repository, tag);
      if (remote === null) throw new Error(`ECR did not return ${image.repository}:${tag} after a successful push.`);
      if (remote.configDigest !== localConfigDigests.get(image.name)) {
        throw new Error(
          `Published image ${image.repository}:${tag} does not match the tested local image configuration.`,
        );
      }
      resolved.set(image.name, remote);
    }
  }

  const images = Object.fromEntries(
    checkpointImages.map((image) => {
      const tag = checkpointTag(commitSha, localConfigDigests.get(image.name));
      const digest = resolved.get(image.name)?.digest;
      if (!digestPattern.test(digest)) throw new Error(`No valid digest was resolved for ${image.repository}:${tag}.`);
      return [
        image.name,
        {
          repository: image.repository,
          tag,
          digest,
          imageUri: `${registry}/${image.repository}@${digest}`,
        },
      ];
    }),
  );
  const manifest = { schemaVersion: 1, commitSha, region, images };
  const manifestPath = resolve(env.CHECKPOINT_IMAGE_MANIFEST ?? 'artifacts/checkpoint-images.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  if (env.GITHUB_STEP_SUMMARY) writeSummary(env.GITHUB_STEP_SUMMARY, manifest);
  return { manifest, manifestPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { manifestPath } = publishCheckpointImages();
    console.log(`Wrote checkpoint image manifest to ${manifestPath}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
