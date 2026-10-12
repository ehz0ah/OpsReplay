import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifestHash } from '../packages/session/src/manifest.js';
import {
  digest,
  referenceBuild,
  referenceIdentity,
  referenceTask,
} from '../packages/content/test/reference-fixture.js';
import { inspectRelease } from './publish-reference-release.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'opsreplay-reference-publication-'));
  const imagesFile = join(directory, 'images.json');
  const images = {
    schemaVersion: 1,
    commitSha: referenceIdentity.commitSha,
    account: referenceIdentity.account,
    region: referenceIdentity.region,
    buildManifestSha256: manifestHash(referenceBuild),
    images: {
      challenge: {
        repository: 'opsreplay/challenge-wrong-upstream-port',
        configDigest: referenceIdentity.challengeConfigDigest,
        digest: referenceIdentity.challengeImageDigest,
        imageUri: `${referenceIdentity.account}.dkr.ecr.${referenceIdentity.region}.amazonaws.com/opsreplay/challenge-wrong-upstream-port@${referenceIdentity.challengeImageDigest}`,
      },
      monitor: {
        repository: 'opsreplay/monitor',
        configDigest: referenceIdentity.monitorConfigDigest,
        digest: referenceIdentity.monitorImageDigest,
        imageUri: `${referenceIdentity.account}.dkr.ecr.${referenceIdentity.region}.amazonaws.com/opsreplay/monitor@${referenceIdentity.monitorImageDigest}`,
      },
    },
  };
  writeFileSync(imagesFile, JSON.stringify(images));
  const config = {
    imagesFile,
    taskDefinitionArn: referenceTask().taskDefinitionArn!,
    executionRoleArn: referenceIdentity.executionRoleArn,
    logGroupName: referenceIdentity.logGroupName,
    proTimeLimitSeconds: 1800,
    tableName: 'opsreplay-sessions',
  };
  return { directory, images, config };
}

function awsRun(account = referenceIdentity.account, wrongConfig = false) {
  return (_command: string, args: string[]) => {
    if (args[0] === 'sts') return JSON.stringify({ Account: account });
    if (args[0] === 'ecs') return JSON.stringify({ taskDefinition: referenceTask() });
    if (args[0] === 'ecr') {
      const repository = args[args.indexOf('--repository-name') + 1]!;
      const image =
        repository === 'opsreplay/monitor'
          ? { digest: referenceIdentity.monitorImageDigest, config: referenceIdentity.monitorConfigDigest }
          : { digest: referenceIdentity.challengeImageDigest, config: referenceIdentity.challengeConfigDigest };
      return JSON.stringify({
        images: [
          {
            imageId: { imageDigest: image.digest },
            imageManifest: JSON.stringify({ config: { digest: wrongConfig ? digest('f') : image.config } }),
          },
        ],
        failures: [],
      });
    }
    throw new Error(`Unexpected AWS command: ${args.join(' ')}`);
  };
}

test('release inspection binds current AWS image and task reads to the embedded tested manifest', () => {
  const { directory, config } = fixture();
  const seen: string[] = [];
  try {
    const release = inspectRelease(
      config,
      (command, args) => {
        seen.push(`${command} ${args[0]} ${args[1]}`);
        return awsRun()(command, args);
      },
      (configDigest) => {
        assert.equal(configDigest, referenceIdentity.monitorConfigDigest);
        return structuredClone(referenceBuild);
      },
    );
    assert.equal(release.buildManifestSha256, manifestHash(referenceBuild));
    assert.equal(release.taskDefinitionArn, config.taskDefinitionArn);
    assert.equal(release.admission.timeLimits.pro, 1800);
    assert.deepEqual(seen, [
      'aws sts get-caller-identity',
      'aws ecr batch-get-image',
      'aws ecr batch-get-image',
      'aws ecs describe-task-definition',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release inspection rejects a wrong account, ECR configuration, or embedded build', () => {
  const { directory, config } = fixture();
  try {
    assert.throws(() => inspectRelease(config, awsRun('999999999999'), () => referenceBuild), /account does not match/);
    assert.throws(
      () => inspectRelease(config, awsRun(referenceIdentity.account, true), () => referenceBuild),
      /does not match the tested configuration/,
    );
    assert.throws(
      () => inspectRelease(config, awsRun(), () => ({ ...referenceBuild, title: 'changed' })),
      /Embedded build manifest does not match/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
