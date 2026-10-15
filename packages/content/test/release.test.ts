import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateTableCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { catalogueKey } from '../src/catalogue.js';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocalDatabase } from '../../../apps/api/test/local-dynamodb.js';
import { manifestKey } from '../../session/src/manifest.js';
import {
  prepareReferenceRelease,
  projectCatalogue,
  publishReferenceRelease,
  releaseGates,
  type PublicationEvidence,
  type ReferenceRelease,
} from '../src/release.js';
import { referenceBuild as build, referenceIdentity as identity, referenceTask as task } from './reference-fixture.js';
function evidence(release: ReferenceRelease): PublicationEvidence {
  return {
    identity: structuredClone(release.identity),
    buildManifestSha256: release.buildManifestSha256,
    manifestSha256: release.manifestSha256,
    taskDefinitionArn: release.taskDefinitionArn,
    gates: Object.fromEntries(
      releaseGates.map((name) => [
        name,
        {
          reference: `review/${name}`,
          passed: true as const,
          ...(name === 'scenarioRepeats' ? { repeats: 20 } : {}),
        },
      ]),
    ) as PublicationEvidence['gates'],
  };
}

test('release completion changes only status and image digests and derives the public admission', () => {
  const release = prepareReferenceRelease(build, identity, task(), 1800);
  const restored = structuredClone(release.manifest);
  restored.status = 'draft';
  restored.environment.image.digest = null;
  restored.environment.monitorImage.digest = null;
  assert.deepEqual(restored, build);
  assert.equal(release.admission.pins.manifestSha256, release.manifestSha256);
  assert.equal(release.admission.pins.taskDefinitionArn, release.taskDefinitionArn);
  assert.equal(release.admission.timeLimits.free, 1200);
  assert.equal(release.admission.timeLimits.pro, 1800);
  assert.deepEqual(
    release.admission.hintPlan,
    build.hints.map(({ id, minElapsedMinutes }: { id: string; minElapsedMinutes: number }) => ({
      id,
      minElapsedMinutes,
    })),
  );
  assert.equal('hints' in release.admission, false);
  assert.equal('debrief' in release.admission, false);
});

test('release preparation rejects incompatible task, content, identity, and plan limits', () => {
  assert.throws(() => prepareReferenceRelease(build, identity, task({ taskRoleArn: identity.executionRoleArn }), 1800));
  assert.throws(() => prepareReferenceRelease(build, identity, task({ enableFaultInjection: true }), 1800));
  assert.throws(() => prepareReferenceRelease(build, identity, task({ cpu: '2048' }), 1800));
  const mutable = task();
  mutable.containerDefinitions![1]!.image = 'opsreplay/monitor:latest';
  assert.throws(() => prepareReferenceRelease(build, identity, mutable, 1800));
  assert.throws(() => prepareReferenceRelease(build, identity, task(), 1200));
  assert.throws(() => prepareReferenceRelease({ ...build, status: 'published' }, identity, task(), 1800));
  assert.throws(() => prepareReferenceRelease(build, { ...identity, account: 'other' }, task(), 1800));
});

async function createTable(client: Awaited<ReturnType<typeof startLocalDatabase>>['client'], tableName: string) {
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
    }),
  );
}

test('identical concurrent publication is idempotent while a conflicting projection cannot overwrite it', async () => {
  const database = await startLocalDatabase();
  const tableName = 'reference-publication';
  try {
    await createTable(database.client, tableName);
    const first = prepareReferenceRelease(build, identity, task(), 1800);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        publishReferenceRelease(database.document, tableName, first, evidence(first), AbortSignal.timeout(10_000)),
      ),
    );
    const conflicting = prepareReferenceRelease(build, identity, task(), 2400);
    await assert.rejects(
      publishReferenceRelease(
        database.document,
        tableName,
        conflicting,
        evidence(conflicting),
        AbortSignal.timeout(10_000),
      ),
    );
    const saved = await database.document.send(
      new GetCommand({
        TableName: tableName,
        Key: { PK: `CONTENT#${build.id}`, SK: `VERSION#${build.version}` },
        ConsistentRead: true,
      }),
    );
    assert.deepEqual(saved.Item?.data, first.admission);
    const privateKey = manifestKey(build.id, build.version, first.manifestSha256);
    const privateSaved = await database.document.send(
      new GetCommand({ TableName: tableName, Key: privateKey, ConsistentRead: true }),
    );
    assert.deepEqual(privateSaved.Item?.data, first.manifest);
    const entry = projectCatalogue(first.manifest);
    const publicSaved = await database.document.send(
      new GetCommand({ TableName: tableName, Key: catalogueKey(entry), ConsistentRead: true }),
    );
    assert.deepEqual(publicSaved.Item?.data, entry);
    assert.equal('pins' in entry, false);
    assert.equal('hints' in entry, false);
  } finally {
    database.close();
  }
});

test('failure after private content storage never creates an admissible version', async () => {
  const database = await startLocalDatabase();
  const tableName = 'reference-partial-publication';
  try {
    await createTable(database.client, tableName);
    const release = prepareReferenceRelease(build, identity, task(), 1800);
    const interrupted = {
      send: async (
        command: PutCommand | GetCommand | TransactWriteCommand,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (command instanceof TransactWriteCommand) throw new Error('injected failure');
        if (command instanceof PutCommand) return database.document.send(command, options);
        return database.document.send(command, options);
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(
      publishReferenceRelease(interrupted, tableName, release, evidence(release), AbortSignal.timeout(10_000)),
      /injected failure/,
    );
    const privateItem = await database.client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          PK: { S: `CONTENT#challenge#${build.id}` },
          SK: { S: `MANIFEST#${build.version}#${release.manifestSha256}` },
        },
        ConsistentRead: true,
      }),
    );
    const admission = await database.client.send(
      new GetItemCommand({
        TableName: tableName,
        Key: { PK: { S: `CONTENT#${build.id}` }, SK: { S: `VERSION#${build.version}` } },
        ConsistentRead: true,
      }),
    );
    assert.ok(privateItem.Item);
    assert.equal(admission.Item, undefined);
    const listed = await database.document.send(
      new GetCommand({ TableName: tableName, Key: catalogueKey(projectCatalogue(release.manifest)) }),
    );
    assert.equal(listed.Item, undefined);
  } finally {
    database.close();
  }
});

test('tampered release and incomplete evidence fail before any content write', async () => {
  const release = prepareReferenceRelease(build, identity, task(), 1800);
  const calls: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      calls.push(command);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  const tampered = structuredClone(release);
  tampered.admission.alert.summary = 'changed';
  await assert.rejects(
    publishReferenceRelease(client, 'test-table', tampered, evidence(tampered), AbortSignal.timeout(1000)),
  );
  const incomplete = evidence(release);
  incomplete.gates.scenarioRepeats.repeats = 19;
  await assert.rejects(publishReferenceRelease(client, 'test-table', release, incomplete, AbortSignal.timeout(1000)));
  assert.equal(calls.length, 0);
});

test('backfills an identical published admission and recovers an uncertain transaction response', async () => {
  const database = await startLocalDatabase();
  const tableName = 'reference-backfill';
  try {
    await createTable(database.client, tableName);
    const release = prepareReferenceRelease(build, identity, task(), 1800);
    await database.document.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: `CONTENT#${build.id}`, SK: `VERSION#${build.version}`, data: release.admission },
      }),
    );
    let writes = 0;
    const uncertain = {
      send: async (
        command: PutCommand | GetCommand | TransactWriteCommand,
        options?: { abortSignal?: AbortSignal },
      ) => {
        if (command instanceof TransactWriteCommand) {
          writes++;
          await database.document.send(command, options);
          throw new Error('lost response');
        }
        if (command instanceof PutCommand) return database.document.send(command, options);
        return database.document.send(command, options);
      },
    } as unknown as DynamoDBDocumentClient;
    await publishReferenceRelease(uncertain, tableName, release, evidence(release), AbortSignal.timeout(10_000));
    assert.equal(writes, 1);
    const entry = projectCatalogue(release.manifest);
    assert.deepEqual(
      (await database.document.send(new GetCommand({ TableName: tableName, Key: catalogueKey(entry) }))).Item?.data,
      entry,
    );
    await database.document.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          PK: `CONTENT#${build.id}`,
          SK: `VERSION#${build.version}`,
          data: { ...release.admission, status: 'retired' },
        },
      }),
    );
    await assert.rejects(
      publishReferenceRelease(database.document, tableName, release, evidence(release), AbortSignal.timeout(10_000)),
    );
  } finally {
    database.close();
  }
});
