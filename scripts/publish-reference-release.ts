import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { TaskDefinition } from '@aws-sdk/client-ecs';
import { boundedRun, referenceImageManifest } from './reference-image-manifest.mjs';
import { canonicalJson } from '../packages/session/src/canonical.js';
import { manifestHash } from '../packages/session/src/manifest.js';
import {
  prepareReferenceRelease,
  publishReferenceRelease,
  type PublicationEvidence,
  type ReferenceRelease,
} from '../packages/content/src/release.js';

interface ImagePublication {
  schemaVersion: number;
  commitSha: string;
  account: string;
  region: string;
  buildManifestSha256: string;
  images: Record<
    'challenge' | 'monitor',
    { repository: string; configDigest: string; digest: string; imageUri: string }
  >;
}
interface PublicationConfig {
  imagesFile: string;
  taskDefinitionArn: string;
  executionRoleArn: string;
  logGroupName: string;
  proTimeLimitSeconds: number;
  tableName: string;
}
export function readJson(path: string): unknown {
  if (statSync(path).size > 1024 * 1024) throw new Error('Publication input exceeds its size bound.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function inspectRelease(
  config: PublicationConfig,
  run = boundedRun,
  readReference = referenceImageManifest,
): ReferenceRelease {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(config.tableName) || typeof config.imagesFile !== 'string')
    throw new Error('Invalid publication configuration.');
  const images = readJson(config.imagesFile) as ImagePublication;
  if (
    images.schemaVersion !== 1 ||
    !/^[0-9]{12}$/.test(images.account) ||
    !/^[a-z]{2}-[a-z]+-[0-9]+$/.test(images.region) ||
    !/^[a-f0-9]{40}$/.test(images.commitSha)
  )
    throw new Error('Invalid image publication identity.');
  const aws = (args: string[]) => run('aws', [...args, '--region', images.region, '--output', 'json']);
  const caller = JSON.parse(aws(['sts', 'get-caller-identity']));
  if (caller.Account !== images.account) throw new Error('Publication account does not match.');
  for (const [name, repository] of [
    ['challenge', 'opsreplay/challenge-wrong-upstream-port'],
    ['monitor', 'opsreplay/monitor'],
  ] as const) {
    const image = images.images[name];
    if (
      image.repository !== repository ||
      !/^sha256:[a-f0-9]{64}$/.test(image.digest) ||
      !/^sha256:[a-f0-9]{64}$/.test(image.configDigest) ||
      image.imageUri !== `${images.account}.dkr.ecr.${images.region}.amazonaws.com/${repository}@${image.digest}`
    )
      throw new Error('Published image pin does not match.');
    const result = JSON.parse(
      aws([
        'ecr',
        'batch-get-image',
        '--repository-name',
        repository,
        '--image-ids',
        `imageDigest=${image.digest}`,
        '--accepted-media-types',
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
      ]),
    );
    if (
      result.images?.length !== 1 ||
      result.failures?.length ||
      result.images[0].imageId.imageDigest !== image.digest ||
      JSON.parse(result.images[0].imageManifest).config?.digest !== image.configDigest
    )
      throw new Error('ECR image does not match the tested configuration.');
  }
  const build = readReference(images.images.monitor.configDigest);
  if (manifestHash(build) !== images.buildManifestSha256)
    throw new Error('Embedded build manifest does not match publication.');
  const task = JSON.parse(aws(['ecs', 'describe-task-definition', '--task-definition', config.taskDefinitionArn]))
    .taskDefinition as TaskDefinition;
  return prepareReferenceRelease(
    build,
    {
      commitSha: images.commitSha,
      account: images.account,
      region: images.region,
      challengeImageDigest: images.images.challenge.digest,
      monitorImageDigest: images.images.monitor.digest,
      challengeConfigDigest: images.images.challenge.configDigest,
      monitorConfigDigest: images.images.monitor.configDigest,
      executionRoleArn: config.executionRoleArn,
      logGroupName: config.logGroupName,
    },
    task,
    config.proTimeLimitSeconds,
  );
}
export async function publicationMain(args: string[]) {
  const [operation, configFile, releaseFile, evidenceFile] = args;
  if (
    (operation !== '--prepare' && operation !== '--apply') ||
    !configFile ||
    !releaseFile ||
    (operation === '--prepare' ? args.length !== 3 : args.length !== 4)
  )
    throw new Error('Use --prepare CONFIG RELEASE, or --apply CONFIG RELEASE EVIDENCE.');
  const config = readJson(configFile) as PublicationConfig;
  const release = inspectRelease(config);
  if (operation === '--prepare') {
    // Contains private content. Never upload as a public artifact or print it.
    writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return;
  }
  if (canonicalJson(readJson(releaseFile)) !== canonicalJson(release))
    throw new Error('Prepared release has changed. Prepare and review it again.');
  const evidence = readJson(evidenceFile!) as PublicationEvidence;
  const client = new DynamoDBClient({
    region: release.identity.region,
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true }),
  });
  try {
    await publishReferenceRelease(
      DynamoDBDocumentClient.from(client),
      config.tableName,
      release,
      evidence,
      AbortSignal.timeout(30_000),
    );
  } finally {
    client.destroy();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  publicationMain(process.argv.slice(2)).catch(() => {
    // Never print SDK input/output or private manifests.
    console.error('Reference publication failed. Inspect the private inputs and retry the same release.');
    process.exitCode = 1;
  });
}
