import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { generate } from 'selfsigned';
import { recordingWorkOrder, unfinishedWorkIndex } from '../../../packages/contracts/private/recording-work.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import { DynamoRecordingWorkSource } from '../src/recording-work-source.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

const createdAt = '2026-10-08T00:00:00.000Z';
const now = '2026-10-08T00:00:10.000Z';

async function certificate(): Promise<string> {
  return (
    await generate([{ name: 'commonName', value: 'opsreplay-monitor' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date('2026-10-07T00:00:00.000Z'),
      notAfterDate: new Date('2026-10-09T00:00:00.000Z'),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
      ],
    })
  ).cert;
}

test('discovers authoritative work through a keys-only GSI and retires its exact index entry', async () => {
  const table = `test-${randomUUID()}`;
  const sessionId = randomUUID();
  const workOrder = recordingWorkOrder(createdAt, sessionId);
  const monitorCertificate = await certificate();
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
        { AttributeName: unfinishedWorkIndex.partitionKey, AttributeType: 'S' },
        { AttributeName: unfinishedWorkIndex.sortKey, AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: unfinishedWorkIndex.name,
          KeySchema: [
            { AttributeName: unfinishedWorkIndex.partitionKey, KeyType: 'HASH' },
            { AttributeName: unfinishedWorkIndex.sortKey, KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
    }),
  );
  await database.document.send(
    new PutCommand({
      TableName: table,
      Item: {
        PK: `SESSION#${sessionId}`,
        SK: 'STATE',
        [unfinishedWorkIndex.partitionKey]: unfinishedWorkIndex.recordingPartition,
        [unfinishedWorkIndex.sortKey]: workOrder,
        data: {
          view: {
            id: sessionId,
            createdAt,
            status: 'provisioning',
            recording: { status: 'pending', reason: null },
          },
          provisioningDeadline: '2026-10-08T00:03:00.000Z',
          monitorSecret: 's'.repeat(43),
          monitorCertificate,
          taskAddress: '10.0.1.42',
        },
      },
    }),
  );

  let indexedItems: Record<string, unknown>[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const indexed = await database.document.send(
      new QueryCommand({
        TableName: table,
        IndexName: unfinishedWorkIndex.name,
        KeyConditionExpression: '#workPartition = :recording',
        ExpressionAttributeNames: { '#workPartition': unfinishedWorkIndex.partitionKey },
        ExpressionAttributeValues: { ':recording': unfinishedWorkIndex.recordingPartition },
      }),
    );
    indexedItems = (indexed.Items ?? []) as Record<string, unknown>[];
    if (indexedItems.length === 1) break;
    await delay(10);
  }
  assert.deepEqual(indexedItems, [
    {
      PK: `SESSION#${sessionId}`,
      SK: 'STATE',
      [unfinishedWorkIndex.partitionKey]: unfinishedWorkIndex.recordingPartition,
      [unfinishedWorkIndex.sortKey]: workOrder,
    },
  ]);

  const source = new DynamoRecordingWorkSource(database.document, table, 'gateway-1');
  assert.deepEqual(await source.discover({ limit: 1, excludedSessionIds: [], now }), {
    work: [
      {
        sessionId,
        workOrder,
        taskAddress: '10.0.1.42',
        monitorCertificate,
        monitorSecret: 's'.repeat(43),
      },
    ],
    invalidEntries: 0,
  });

  const setStatus = (status: 'ready' | 'resolved', recordingStatus: 'recording' | 'complete') =>
    database.document.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: `SESSION#${sessionId}`, SK: 'STATE' },
        UpdateExpression: 'SET #data.#view.#status = :status, #data.#view.#recording.#status = :recordingStatus',
        ExpressionAttributeNames: {
          '#data': 'data',
          '#view': 'view',
          '#status': 'status',
          '#recording': 'recording',
        },
        ExpressionAttributeValues: { ':status': status, ':recordingStatus': recordingStatus },
      }),
    );
  await setStatus('resolved', 'complete');

  let changedState = false;
  const racingClient = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof UpdateCommand && command.input.UpdateExpression?.startsWith('REMOVE ')) {
        changedState = true;
        await setStatus('ready', 'recording');
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const racingSource = new DynamoRecordingWorkSource(racingClient, table, 'gateway-1');
  assert.equal(await racingSource.retire({ sessionId, workOrder }), 'not_terminal');
  assert.equal(changedState, true);
  const afterRace = await database.document.send(
    new GetCommand({ TableName: table, Key: { PK: `SESSION#${sessionId}`, SK: 'STATE' }, ConsistentRead: true }),
  );
  assert.equal(afterRace.Item?.[unfinishedWorkIndex.sortKey], workOrder);

  await setStatus('resolved', 'complete');
  assert.equal(await source.retire({ sessionId, workOrder }), 'retired');
  const stored = await database.document.send(
    new GetCommand({ TableName: table, Key: { PK: `SESSION#${sessionId}`, SK: 'STATE' }, ConsistentRead: true }),
  );
  assert.equal(stored.Item?.[unfinishedWorkIndex.partitionKey], undefined);
  assert.equal(stored.Item?.[unfinishedWorkIndex.sortKey], undefined);

  for (let attempt = 0; attempt < 100; attempt++) {
    const indexed = await database.document.send(
      new QueryCommand({
        TableName: table,
        IndexName: unfinishedWorkIndex.name,
        KeyConditionExpression: '#workPartition = :recording',
        ExpressionAttributeNames: { '#workPartition': unfinishedWorkIndex.partitionKey },
        ExpressionAttributeValues: { ':recording': unfinishedWorkIndex.recordingPartition },
      }),
    );
    if ((indexed.Items ?? []).length === 0) return;
    await delay(10);
  }
  assert.fail('Retired work remained in the sparse index');
});
