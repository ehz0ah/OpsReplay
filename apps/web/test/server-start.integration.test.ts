import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { RunTaskCommand, type ECSClient } from '@aws-sdk/client-ecs';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { ApiClient, ApiError, TransportError } from '../src/api.js';
import { startAttempt } from '../src/start-attempt.js';
import { MutationJournal } from '../src/mutation-journal.js';
import { createStartHandler } from '../../api/src/start-session/handler.js';
import { StartStore, keys } from '../../api/src/start-session/store.js';
import { LifecycleStore } from '../../api/src/session-lifecycle/store.js';
import { createProvisionSession } from '../../api/src/session-lifecycle/provision.js';
import { createMonitorCertificate } from '../../api/src/session-lifecycle/monitor-certificate.js';
import { FargateEnvironment } from '../../api/src/session-lifecycle/aws-environment.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import { prepareReferenceRelease } from '../../../packages/content/src/release.js';
import { referenceBuild, referenceIdentity, referenceTask } from '../../../packages/content/test/reference-fixture.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());
const owner = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';
const now = () => new Date('2026-10-17T00:00:00.000Z');

async function fixture() {
  const table = `test-${randomUUID()}`;
  await database.client.send(
    new CreateTableCommand({
      TableName: table,
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
  const content = prepareReferenceRelease(referenceBuild, referenceIdentity, referenceTask(), 1800).admission;
  const contentKey = keys.content(content.challenge.id, content.challenge.version);
  await database.document.send(new PutCommand({ TableName: table, Item: { ...contentKey, data: content } }));
  const store = new StartStore(database.document, table);
  const taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/' + 'a'.repeat(32);
  let launches = 0;
  const environment = new FargateEnvironment({
    send: async (command: RunTaskCommand) => {
      assert.ok(command instanceof RunTaskCommand);
      assert.equal(command.input.clientToken, command.input.startedBy);
      launches++;
      return { tasks: [{ taskArn }] };
    },
  } as unknown as ECSClient);
  const provision = createProvisionSession({
    store: new LifecycleStore(database.document, table),
    environment,
    bootstrap: { ensure: async (session) => (await createMonitorCertificate(session)).certificate },
    schedule: { ensure: async () => {} },
    now,
  });
  const handler = createStartHandler({
    store,
    provision,
    now,
    launchConfiguration: {
      clusterArn: 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test',
      subnetIds: ['subnet-0123456789abcdef0'],
      securityGroupIds: ['sg-0123456789abcdef0'],
      platformVersion: '1.4.0',
      monitorContainerName: 'monitor',
      secretBucketArn: 'arn:aws:s3:::test-secrets',
    },
  });
  const storage = new InMemoryWebStorage();
  const sentIds: string[] = [];
  let actor = owner;
  const api = new ApiClient(
    'https://api.example',
    async () => 'test-token',
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      sentIds.push(body.requestId);
      // Synthetic authorizer claims and external ECS/schedule adapters are local
      // test boundaries. The browser, handler and DynamoDB transactions are real.
      const response = await handler(
        {
          httpMethod: 'POST',
          resource: '/v1/sessions',
          body: JSON.stringify(body),
          isBase64Encoded: false,
          requestContext: { authorizer: { claims: { sub: actor } } },
        } as unknown as APIGatewayProxyEvent,
        { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 25_000 },
      );
      if (sentIds.length === 1) {
        assert.equal(response.statusCode, 200);
        throw new Error('Accepted response interrupted');
      }
      return new Response(response.body, { status: response.statusCode });
    },
  );
  const pending = {
    kind: 'start' as const,
    path: '/v1/sessions' as const,
    body: {
      requestId: randomUUID(),
      challengeId: content.challenge.id,
      challengeVersion: content.challenge.version,
    },
  };
  return {
    store,
    api,
    storage,
    pending,
    sentIds,
    taskArn,
    launches: () => launches,
    actor: (value: string) => {
      actor = value;
    },
    retire: () => database.document.send(new DeleteCommand({ TableName: table, Key: contentKey })),
    rows: async () =>
      (await database.document.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? [],
  };
}

test('browser reload recovers an accepted start through the real handler and store without another launch', async () => {
  const f = await fixture();
  await assert.rejects(startAttempt(f.api, new MutationJournal(f.storage, owner), f.pending), TransportError);
  const receipt = await f.store.receipt(owner, f.pending.body.requestId);
  assert.ok(receipt);
  assert.equal((await f.store.session(receipt.sessionId))!.taskArn, f.taskArn);
  assert.equal(f.launches(), 1);
  await f.retire();
  const reloaded = new MutationJournal(f.storage, owner);
  const resumed = await startAttempt(f.api, reloaded, {
    ...f.pending,
    body: { ...f.pending.body, requestId: randomUUID() },
  });
  assert.equal(resumed.id, receipt.sessionId);
  assert.equal(resumed.status, 'provisioning');
  assert.deepEqual(f.sentIds, [f.pending.body.requestId, f.pending.body.requestId]);
  assert.equal(f.launches(), 1);
  assert.equal(reloaded.load('start', '/v1/sessions'), null);
  assert.equal((await f.store.active(owner))!.sessionId, receipt.sessionId);
  assert.equal((await f.rows()).filter((row) => String(row.PK).startsWith('SESSION#') && row.SK === 'STATE').length, 1);
});

test('identity changes cannot recover another learner receipt or clear their uncertain start', async () => {
  const f = await fixture();
  await assert.rejects(startAttempt(f.api, new MutationJournal(f.storage, owner), f.pending), TransportError);
  const receipt = await f.store.receipt(owner, f.pending.body.requestId);
  assert.ok(receipt);
  f.actor(other);
  const journal = new MutationJournal(f.storage, other);
  assert.equal(journal.load('start', '/v1/sessions'), null);
  await f.retire();
  await assert.rejects(
    startAttempt(f.api, journal, f.pending),
    (error: unknown) => error instanceof ApiError && error.detail.code === 'VERSION_UNAVAILABLE',
  );
  assert.equal(await f.store.receipt(other, f.pending.body.requestId), undefined);
  assert.equal(await f.store.active(other), undefined);
  assert.equal((await f.store.receipt(owner, f.pending.body.requestId))!.sessionId, receipt.sessionId);
  assert.deepEqual(new MutationJournal(f.storage, owner).load('start', '/v1/sessions'), f.pending);
  assert.equal(f.launches(), 1);
});
