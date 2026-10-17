import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { GetCommand, PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { catalogueKey, validCatalogEntry, type CatalogEntry } from './catalogue.js';
import type { TaskDefinition, ContainerDefinition } from '@aws-sdk/client-ecs';
import challengeSchema from '../../contracts/schemas/challenge.schema.json';
import { canonicalJson } from '../../session/src/canonical.js';
import { manifestHash, manifestKey, manifestMaximumBytes } from '../../session/src/manifest.js';
import { validContent } from '../../../apps/api/src/start-session/validation.js';
import type { ContentVersion } from '../../../apps/api/src/start-session/types.js';
import type { DebriefManifest } from '../../session/src/debrief.js';
import { parseConfig } from '../../../apps/monitor/src/config.js';
import { measurementDescriptors } from '../../../apps/monitor/src/measurement-descriptors.js';
import { environmentWatchedVolume } from '../../../infra/environment-watched-volume.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateManifest = ajv.compile(challengeSchema);
export const releaseGates = [
  'scenarioRepeats',
  'playback',
  'fargateIsolation',
  'publicSecrecy',
  'contentReview',
] as const;
export interface BuildManifest extends DebriefManifest {
  status: 'draft' | 'published';
  title: string;
  summary: string;
  tier: ContentVersion['challenge']['tier'];
  category: string;
  plan: ContentVersion['plan'];
  environment: {
    image: { repository: string; digest: string | null };
    monitorImage: { repository: string; digest: string | null };
    cpu: number;
    memoryMiB: number;
    timeLimitMinutes: number;
    services: { name: string; configFiles: string[]; logFiles: string[] }[];
  };
  alert: ContentVersion['alert'];
  dashboard: (ContentVersion['dashboard'][number] & { source: string })[];
  hints: { id: string; text: string; minElapsedMinutes: number }[];
  plantedFault: { files: string[] };
}
export interface ReleaseIdentity {
  commitSha: string;
  account: string;
  region: string;
  challengeImageDigest: string;
  monitorImageDigest: string;
  challengeConfigDigest: string;
  monitorConfigDigest: string;
  executionRoleArn: string;
  logGroupName: string;
}
export interface ReferenceRelease {
  schemaVersion: 1;
  identity: ReleaseIdentity;
  buildManifestSha256: string;
  manifestSha256: string;
  taskDefinitionArn: string;
  manifest: BuildManifest;
  admission: ContentVersion;
}
export function projectCatalogue(manifest: BuildManifest): CatalogEntry {
  const entry: CatalogEntry = {
    id: manifest.id,
    version: manifest.version,
    mode: 'challenge',
    title: manifest.title,
    summary: manifest.summary,
    category: manifest.category,
    plan: manifest.plan,
    tier: manifest.tier,
  };
  if (manifest.status !== 'published' || !validCatalogEntry(entry)) fail();
  return entry;
}
export interface PublicationEvidence {
  identity: ReleaseIdentity;
  buildManifestSha256: string;
  manifestSha256: string;
  taskDefinitionArn: string;
  gates: Record<(typeof releaseGates)[number], { reference: string; passed: true; repeats?: number }>;
}
function fail(): never {
  throw new Error('Reference release validation failed.');
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function unique(ids: string[]) {
  if (new Set(ids).size !== ids.length) fail();
}
export function assertBuildManifest(value: unknown): asserts value is BuildManifest {
  if (!validateManifest(value) || Buffer.byteLength(canonicalJson(value)) > manifestMaximumBytes) fail();
  const m = value as unknown as BuildManifest;
  for (const descriptor of m.dashboard) {
    if (
      !Object.hasOwn(measurementDescriptors, descriptor.id) ||
      descriptor.source !== descriptor.id ||
      descriptor.unit !== measurementDescriptors[descriptor.id as keyof typeof measurementDescriptors]
    )
      fail();
  }
  if (
    !['wrong-upstream-port', 'stale-dns-record'].includes(m.id) ||
    m.environment.image.repository !== `opsreplay/challenge-${m.id}` ||
    m.environment.monitorImage.repository !== 'opsreplay/monitor'
  )
    fail();
  // Reuse the runtime validator, including loopback endpoints, watched paths and recording bounds.
  parseConfig(JSON.stringify(value));
  for (const values of [m.traps, m.hints, m.dashboard, m.debrief.keyEvidence]) unique(values.map((v) => v.id));
  unique(m.environment.services.map((v) => v.name));
  const probes = new Set(m.healthProbes.map((v) => v.id));
  const configs = new Set(m.environment.services.flatMap((v) => v.configFiles));
  if (m.traps.some((v) => !probes.has(v.probe)) || m.plantedFault.files.some((v) => !configs.has(v))) fail();
  if (m.hints.some((v, i) => i > 0 && v.minElapsedMinutes < m.hints[i - 1]!.minElapsedMinutes)) fail();
  try {
    for (const pattern of [
      ...m.traps.flatMap((v) => v.commandPatterns),
      ...m.debrief.keyEvidence.flatMap((v) => [...v.commandPatterns, ...v.outputPatterns]),
    ])
      new RegExp(pattern);
  } catch {
    fail();
  }
  if (m.status === 'published' && (!m.environment.image.digest || !m.environment.monitorImage.digest)) fail();
}

function assertContainer(container: ContainerDefinition, expected: ContainerDefinition) {
  // DescribeTaskDefinition can return empty collections and false defaults. No extra effective configuration is allowed.
  const normalized = Object.fromEntries(
    Object.entries(container).filter(
      ([, v]) => v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0),
    ),
  );
  const expectedNormalized = Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== false));
  if (container.dockerLabels && Object.keys(container.dockerLabels).length === 0) delete normalized.dockerLabels;
  if (container.linuxParameters) {
    const linux = container.linuxParameters;
    if (linux.devices?.length === 0) delete linux.devices;
    if (linux.tmpfs?.length === 0) delete linux.tmpfs;
    if (linux.capabilities?.add?.length === 0) delete linux.capabilities.add;
  }
  if (container.logConfiguration?.secretOptions?.length === 0) delete container.logConfiguration.secretOptions;
  for (const mapping of (normalized.portMappings as NonNullable<ContainerDefinition['portMappings']>) ?? []) {
    if (mapping.hostPort === mapping.containerPort) delete mapping.hostPort;
  }
  if (!equal(normalized, expectedNormalized)) fail();
}
function assertTask(task: TaskDefinition, build: BuildManifest, identity: ReleaseIdentity): string {
  const arn = task.taskDefinitionArn;
  const prefix = `arn:aws:ecs:${identity.region}:${identity.account}:task-definition/opsreplay-${build.id}:`;
  if (
    !arn?.startsWith(prefix) ||
    !/^[1-9][0-9]*$/.test(arn.slice(prefix.length)) ||
    task.status !== 'ACTIVE' ||
    task.family !== `opsreplay-${build.id}` ||
    task.networkMode !== 'awsvpc' ||
    task.taskRoleArn ||
    task.pidMode ||
    task.ipcMode ||
    task.cpu !== String(build.environment.cpu) ||
    task.memory !== String(build.environment.memoryMiB) ||
    task.cpu !== '1024' ||
    task.memory !== '2048' ||
    !equal(task.runtimePlatform, { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' }) ||
    !equal(task.requiresCompatibilities, ['FARGATE']) ||
    task.executionRoleArn !== identity.executionRoleArn ||
    task.enableFaultInjection === true ||
    task.proxyConfiguration ||
    task.inferenceAccelerators?.length ||
    task.placementConstraints?.length ||
    (task.ephemeralStorage && task.ephemeralStorage.sizeInGiB !== 20)
  )
    fail();
  const layout = environmentWatchedVolume();
  const volumes = structuredClone(task.volumes);
  if (volumes?.[0]?.host && equal(volumes[0].host, {})) delete volumes[0].host;
  if (task.containerDefinitions?.length !== 2 || !equal(volumes, [layout.volume])) fail();
  const image = (repository: string, digest: string) =>
    `${identity.account}.dkr.ecr.${identity.region}.amazonaws.com/${repository}@${digest}`;
  const common = { essential: true, stopTimeout: 30 };
  const expected: ContainerDefinition[] = [
    {
      ...common,
      name: 'challenge',
      image: image(build.environment.image.repository, identity.challengeImageDigest),
      user: '0',
      cpu: 768,
      memory: 1536,
      readonlyRootFilesystem: false,
      versionConsistency: 'enabled',
      linuxParameters: {
        initProcessEnabled: true,
        capabilities: { drop: ['NET_RAW', 'SETPCAP', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SYS_CHROOT'] },
      },
      environment: [layout.challenge.environment],
      mountPoints: [{ ...layout.challenge.mountPoint, readOnly: false }],
      portMappings: [{ name: 'terminal', containerPort: 7681, protocol: 'tcp' }],
    },
    {
      ...common,
      name: 'monitor',
      image: image(build.environment.monitorImage.repository, identity.monitorImageDigest),
      user: '1000',
      cpu: 256,
      memory: 512,
      readonlyRootFilesystem: true,
      versionConsistency: 'enabled',
      linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
      dependsOn: [{ containerName: 'challenge', condition: 'START' }],
      mountPoints: [{ ...layout.monitor.mountPoint, readOnly: true }],
      portMappings: [{ name: 'monitor-control', containerPort: 9443, protocol: 'tcp' }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': identity.logGroupName,
          'awslogs-region': identity.region,
          'awslogs-stream-prefix': 'monitor',
          mode: 'non-blocking',
          'max-buffer-size': '1m',
        },
      },
    },
  ];
  for (const container of expected) {
    const actual = task.containerDefinitions.find((v) => v.name === container.name);
    if (!actual) fail();
    assertContainer(structuredClone(actual), container);
  }
  return arn;
}
export function prepareReferenceRelease(
  build: unknown,
  identity: ReleaseIdentity,
  task: TaskDefinition,
  proTimeLimitSeconds: number,
): ReferenceRelease {
  assertBuildManifest(build);
  if (
    !/^[a-f0-9]{40}$/.test(identity.commitSha) ||
    !/^[0-9]{12}$/.test(identity.account) ||
    !/^[a-z]{2}-[a-z]+-[0-9]+$/.test(identity.region) ||
    !identity.executionRoleArn.startsWith(`arn:aws:iam::${identity.account}:role/`) ||
    !/^\/opsreplay\/[A-Za-z0-9_./-]+$/.test(identity.logGroupName)
  )
    fail();
  for (const d of [
    identity.challengeImageDigest,
    identity.monitorImageDigest,
    identity.challengeConfigDigest,
    identity.monitorConfigDigest,
  ])
    if (!/^sha256:[a-f0-9]{64}$/.test(d)) fail();
  if (
    build.status !== 'draft' ||
    build.environment.image.digest !== null ||
    build.environment.monitorImage.digest !== null
  )
    fail();
  const arn = assertTask(task, build, identity);
  const manifest = structuredClone(build);
  manifest.status = 'published';
  manifest.environment.image.digest = identity.challengeImageDigest;
  manifest.environment.monitorImage.digest = identity.monitorImageDigest;
  assertBuildManifest(manifest);
  const sha256 = manifestHash(manifest);
  const admission = projectAdmission(manifest, identity, arn, proTimeLimitSeconds);
  return {
    schemaVersion: 1,
    identity: structuredClone(identity),
    buildManifestSha256: manifestHash(build),
    manifestSha256: sha256,
    taskDefinitionArn: arn,
    manifest,
    admission,
  };
}
function projectAdmission(
  manifest: BuildManifest,
  identity: ReleaseIdentity,
  arn: string,
  proTimeLimitSeconds: number,
): ContentVersion {
  const sha256 = manifestHash(manifest);
  const admission: ContentVersion = {
    mode: 'challenge',
    status: 'published',
    plan: manifest.plan,
    challenge: {
      id: manifest.id,
      version: manifest.version,
      title: manifest.title,
      tier: manifest.tier,
      category: manifest.category,
    },
    alert: structuredClone(manifest.alert),
    dashboard: manifest.dashboard.map(({ id, label, unit }) => ({ id, label, unit })),
    hintPlan: manifest.hints.map(({ id, minElapsedMinutes }) => ({ id, minElapsedMinutes })),
    timeLimits: { free: manifest.environment.timeLimitMinutes * 60, pro: proTimeLimitSeconds },
    pins: {
      taskDefinitionArn: arn,
      challengeImageDigest: identity.challengeImageDigest,
      monitorImageDigest: identity.monitorImageDigest,
      manifestSha256: sha256,
    },
  };
  if (!validContent(admission) || proTimeLimitSeconds <= admission.timeLimits.free) fail();
  return admission;
}
export function assertPublicationEvidence(release: ReferenceRelease, evidence: PublicationEvidence): void {
  if (
    !evidence ||
    !equal(evidence.identity, release.identity) ||
    evidence.buildManifestSha256 !== release.buildManifestSha256 ||
    evidence.manifestSha256 !== release.manifestSha256 ||
    evidence.taskDefinitionArn !== release.taskDefinitionArn
  )
    fail();
  for (const name of releaseGates) {
    const gate = evidence.gates?.[name];
    if (
      gate?.passed !== true ||
      typeof gate.reference !== 'string' ||
      gate.reference.trim().length < 1 ||
      gate.reference.length > 1000 ||
      (name === 'scenarioRepeats' && (!Number.isInteger(gate.repeats) || gate.repeats! < 20))
    )
      fail();
  }
}
async function immutablePut(
  client: DynamoDBDocumentClient,
  table: string,
  key: { PK: string; SK: string },
  data: unknown,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  try {
    await client.send(
      new PutCommand({ TableName: table, Item: { ...key, data }, ConditionExpression: 'attribute_not_exists(PK)' }),
      { abortSignal: signal },
    );
  } catch (error) {
    signal.throwIfAborted();
    const saved = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }), {
      abortSignal: signal,
    });
    if (saved.Item?.data === undefined || !equal(saved.Item.data, data)) throw error;
  }
}
/** Revalidates all projections. The operator CLI also rereads the actual image and registered task before apply. */
export async function publishReferenceRelease(
  client: DynamoDBDocumentClient,
  table: string,
  release: ReferenceRelease,
  evidence: PublicationEvidence,
  signal: AbortSignal,
): Promise<void> {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(table) || release.schemaVersion !== 1) fail();
  assertBuildManifest(release.manifest);
  const build = structuredClone(release.manifest);
  build.status = 'draft';
  build.environment.image.digest = null;
  build.environment.monitorImage.digest = null;
  if (
    manifestHash(build) !== release.buildManifestSha256 ||
    release.manifest.status !== 'published' ||
    release.manifest.environment.image.digest !== release.identity.challengeImageDigest ||
    release.manifest.environment.monitorImage.digest !== release.identity.monitorImageDigest ||
    release.taskDefinitionArn !== release.admission.pins.taskDefinitionArn ||
    release.admission.challenge.id !== build.id ||
    release.admission.challenge.version !== build.version ||
    !validContent(release.admission) ||
    release.admission.pins.manifestSha256 !== manifestHash(release.manifest) ||
    release.manifestSha256 !== release.admission.pins.manifestSha256
  )
    fail();
  const proTimeLimitSeconds = release.admission.timeLimits.pro;
  if (
    proTimeLimitSeconds === null ||
    !equal(
      release.admission,
      projectAdmission(release.manifest, release.identity, release.taskDefinitionArn, proTimeLimitSeconds),
    )
  )
    fail();
  assertPublicationEvidence(release, evidence);
  const key = manifestKey(release.manifest.id, release.manifest.version, release.manifestSha256);
  await immutablePut(client, table, key, release.manifest, signal);
  const saved = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }), {
    abortSignal: signal,
  });
  if (!equal(saved.Item?.data, release.manifest)) fail();
  const entry = projectCatalogue(release.manifest);
  const projections = [
    {
      key: { PK: `CONTENT#${release.manifest.id}`, SK: `VERSION#${release.manifest.version}` },
      data: release.admission,
    },
    { key: catalogueKey(entry), data: entry },
  ];
  signal.throwIfAborted();
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: projections.map(({ key, data }) => ({
          Put: {
            TableName: table,
            Item: { ...key, data },
            // This also backfills an existing identical admission record. A different
            // release or retired version cannot be overwritten by a retry.
            ConditionExpression: 'attribute_not_exists(PK) OR #data = :expected',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: { ':expected': data },
          },
        })),
      }),
      { abortSignal: signal },
    );
  } catch (error) {
    signal.throwIfAborted();
    // A lost response or concurrent identical publication is successful only when
    // both immutable projections are visible with the complete expected values.
    for (const { key: projectionKey, data } of projections) {
      const result = await client.send(new GetCommand({ TableName: table, Key: projectionKey, ConsistentRead: true }), {
        abortSignal: signal,
      });
      if (!equal(result.Item?.data, data)) throw error;
    }
  }
}
