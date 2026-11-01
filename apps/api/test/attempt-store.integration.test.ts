import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { createEndSessionHandler } from '../src/end-session/handler.js';
import { DynamoMonitorRecordingStore } from '../../gateway/src/monitor-recording-store.js';
import { createReconcileSession } from '../src/session-lifecycle/reconcile.js';
import { startLocalDatabase } from './local-dynamodb.js';
import { sessionRecord } from './session-fixture.js';
import { DynamoAttemptStore, AttemptStoreError } from '../../../packages/session/src/attempt-store.js';
import {
  advanceTerminalCheckpoint,
  initialTerminalCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import { terminalPage, terminalReady } from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { initialSessionLifecycle, lifecycleWorkItem } from '../../../packages/contracts/private/session-lifecycle.js';
let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());
const at = (seconds: number) => new Date(Date.parse('2026-10-12T00:00:00.000Z') + seconds * 1000).toISOString();
async function fixture() {
  const id = randomUUID();
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
  const session = sessionRecord(id);
  session.ownerId = 'learner-1';
  session.view.createdAt = at(0);
  session.accessGrant.admittedAt = at(0);
  session.provisioningDeadline = at(180);
  session.taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/test/1234';
  session.taskAddress = '10.0.1.42';
  session.view.recording.status = 'recording';
  const key = (SK: string) => ({ PK: `SESSION#${id}`, SK });
  const put = (SK: string, data: unknown) =>
    database.document.send(new PutCommand({ TableName: table, Item: { ...key(SK), data } }));
  await put('STATE', session);
  await database.document.send(
    new PutCommand({ TableName: table, Item: lifecycleWorkItem(initialSessionLifecycle(id, at(0))) }),
  );
  await database.document.send(
    new PutCommand({
      TableName: table,
      Item: { PK: 'USER#learner-1', SK: 'ACTIVE', data: { sessionId: id, requestId: randomUUID() } },
    }),
  );
  const recording = {
    schemaVersion: 1,
    status: 'recording',
    recorderId: 'gateway-1',
    generation: 1,
    leaseExpiresAt: at(90),
    startedAt: at(1),
    source: randomUUID(),
    cursor: 1,
    cutoffAt: null,
    drainDeadlineAt: null,
    sealed: null,
    retainUntil: null,
    reason: null,
    updatedAt: at(1),
    completedAt: null,
  };
  await put('RECORDING', recording);
  const observation = {
    schemaVersion: 1,
    sessionId: id,
    startedAt: at(1),
    source: recording.source,
    cursor: 1,
    sequence: 1,
    at: at(1),
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
  await put('MONITOR_OBSERVATION', observation);
  const terminal = advanceTerminalCheckpoint(
    initialTerminalCheckpoint(terminalReady({ startedAt: at(0) })),
    terminalPage(undefined, {
      startedAt: at(0),
      events: [{ type: 'dimensions', sequence: 1, recordedAt: at(0), columns: 80, rows: 24 }],
    }),
  );
  await put('TERMINAL_RECORDING', terminal);
  const store = new DynamoAttemptStore(database.document, table);
  const lease = { sessionId: id, recorderId: 'gateway-1', generation: 1 };
  const ready = () =>
    store.ready(lease, at(1), terminal, { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 }, at(2));
  const get = async (SK: string) =>
    (await database.document.send(new GetCommand({ TableName: table, Key: key(SK), ConsistentRead: true }))).Item?.data;
  return { id, table, key, put, get, session, recording, observation, terminal, store, lease, ready };
}

function withReadHook(
  f: Awaited<ReturnType<typeof fixture>>,
  afterRead: (key: string) => Promise<void> = async () => {},
) {
  const reads: string[] = [];
  const writes: TransactWriteCommand[] = [];
  const client = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) writes.push(command);
      if (command instanceof GetCommand) reads.push(command.input.Key!.SK);
      const result = await database.document.send(command as TransactWriteCommand, options as never);
      // Let a real competing transaction commit after this read has captured its snapshot.
      if (command instanceof GetCommand) await afterRead(command.input.Key!.SK);
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  return { store: new DynamoAttemptStore(client, f.table), reads, writes };
}

test('readiness saves measurement origin under the current lease and requires committed terminal evidence', async () => {
  const f = await fixture();
  await assert.rejects(
    f.store.ready(
      { ...f.lease, generation: 2 },
      at(1),
      f.terminal,
      { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
      at(2),
    ),
  );
  assert.equal((await f.store.session(f.id))?.view.status, 'provisioning');
  const results = await Promise.all([f.ready(), f.ready()]);
  assert.equal(results[0]!.view.readyAt, at(1));
  assert.equal(results[0]!.view.endsAt, at(1201));
  assert.equal(results[0]!.view.hints.nextAvailableAt, at(181));
  assert.deepEqual(results[0], results[1]);
  assert.equal((await f.store.lifecycle(f.id))?.lastSeenAt, at(1));
});

test('readiness retries one real lease renewal and reports exhausted renewals as a domain conflict', async (t) => {
  for (const count of [1, 3]) {
    await t.test(`${count} renewals`, async () => {
      const f = await fixture();
      const recordings = new DynamoMonitorRecordingStore(database.document, f.table);
      const lifecycle = await f.store.lifecycle(f.id);
      let renewals = 0;
      const hooked = withReadHook(f, async (key) => {
        if (key === 'RECORDING' && renewals < count) await recordings.renew(f.lease, at(70 + renewals++), 30_000);
      });
      const ready = () =>
        hooked.store.ready(
          f.lease,
          at(1),
          f.terminal,
          { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
          at(74),
        );
      if (count === 1) {
        assert.equal((await ready()).view.status, 'ready');
        assert.equal(hooked.writes.length, 2);
      } else {
        await assert.rejects(
          ready(),
          (error: unknown) => error instanceof AttemptStoreError && error.code === 'conflict',
        );
        assert.equal(hooked.writes.length, 3);
        assert.equal((await f.store.session(f.id))?.view.status, 'provisioning');
        assert.deepEqual(await f.store.lifecycle(f.id), lifecycle);
        assert.equal((await ready()).view.status, 'ready');
        assert.equal(hooked.writes.length, 4);
      }
      assert.equal(renewals, count);
    });
  }
});

test('readiness rechecks takeover, end, and deadlines after contention', async (t) => {
  for (const change of ['takeover', 'end', 'provisioning-deadline', 'measurement-deadline'] as const) {
    await t.test(change, async () => {
      const f = await fixture();
      const recordings = new DynamoMonitorRecordingStore(database.document, f.table);
      let changed = false;
      const hooked = withReadHook(f, async (key) => {
        if (key !== 'RECORDING' || changed) return;
        changed = true;
        if (change === 'takeover') {
          await recordings.claim({ sessionId: f.id, recorderId: 'gateway-2', now: at(91) });
        } else if (change === 'end') {
          await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
        } else {
          await f.put(
            'STATE',
            change === 'provisioning-deadline'
              ? { ...f.session, provisioningDeadline: at(2) }
              : {
                  ...f.session,
                  view: { ...f.session.view, timeLimitSeconds: 60 },
                  accessGrant: { ...f.session.accessGrant, timeLimitSeconds: 60 },
                },
          );
        }
      });
      const ready = () =>
        hooked.store.ready(
          f.lease,
          at(1),
          f.terminal,
          { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
          at(change === 'measurement-deadline' ? 61 : 2),
        );
      if (change === 'end') {
        assert.equal((await ready()).view.status, 'ended');
      } else {
        await assert.rejects(
          ready(),
          (error: unknown) =>
            error instanceof AttemptStoreError && error.code === (change === 'takeover' ? 'stale_lease' : 'conflict'),
        );
      }
      assert.equal(changed, true);
      assert.equal(hooked.writes.length, 1);
      assert.equal((await f.store.lifecycle(f.id))?.readyAt, null);
      assert.equal((await f.store.session(f.id))?.view.readyAt, null);
    });
  }
});

test('readiness keeps exact terminal evidence conditions after retry exhaustion', async () => {
  const f = await fixture();
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: f.key('TERMINAL_RECORDING') }));
  const hooked = withReadHook(f);
  await assert.rejects(
    hooked.store.ready(
      f.lease,
      at(1),
      f.terminal,
      { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
      at(2),
    ),
    (error: unknown) => error instanceof AttemptStoreError && error.code === 'conflict',
  );
  assert.equal(hooked.writes.length, 3);
  assert.equal((await f.store.session(f.id))?.view.status, 'provisioning');
  assert.equal((await f.store.lifecycle(f.id))?.readyAt, null);
  await f.put('TERMINAL_RECORDING', f.terminal);
  assert.equal((await f.ready()).view.status, 'ready');
});

test('readiness retries only known contention and preserves cancellation and storage errors', async (t) => {
  const failures = [
    { name: 'ConditionalCheckFailedException', retry: true },
    { name: 'TransactionConflictException', retry: true },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
      retry: true,
    },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'TransactionConflict' }],
      retry: true,
    },
    { name: 'TransactionCanceledException', retry: false },
    { name: 'TransactionCanceledException', CancellationReasons: [], retry: false },
    { name: 'TransactionCanceledException', CancellationReasons: 'ConditionalCheckFailed', retry: false },
    { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }], retry: false },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'ValidationError' }],
      retry: false,
    },
    { name: 'TransactionCanceledException', CancellationReasons: [null], retry: false },
    {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}],
      retry: false,
    },
    { name: 'AccessDeniedException', retry: false },
    { name: 'ValidationException', retry: false },
    { name: 'AbortError', retry: false },
  ];
  for (const [index, failure] of failures.entries()) {
    await t.test(`${index}: ${failure.name}`, async () => {
      const f = await fixture();
      const error = Object.assign(new Error('Injected storage failure'), failure);
      let writes = 0;
      const client = {
        send: async (command: unknown, options: unknown) => {
          if (command instanceof TransactWriteCommand) {
            writes++;
            throw error;
          }
          return database.document.send(command as GetCommand, options as never);
        },
      } as unknown as DynamoDBDocumentClient;
      await assert.rejects(
        new DynamoAttemptStore(client, f.table).ready(
          f.lease,
          at(1),
          f.terminal,
          { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
          at(2),
        ),
        (value: unknown) =>
          failure.retry ? value instanceof AttemptStoreError && value.code === 'conflict' : value === error,
      );
      assert.equal(writes, failure.retry ? 3 : 1);
      assert.equal((await f.store.session(f.id))?.view.status, 'provisioning');
      assert.equal((await f.store.lifecycle(f.id))?.readyAt, null);
    });
  }
  await t.test('caller abort during contention', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const error = Object.assign(new Error('Contended write'), { name: 'TransactionConflictException' });
    let writes = 0;
    const client = {
      send: async (command: unknown, options: unknown) => {
        if (command instanceof TransactWriteCommand) {
          writes++;
          controller.abort();
          throw error;
        }
        return database.document.send(command as GetCommand, options as never);
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(
      new DynamoAttemptStore(client, f.table).ready(
        f.lease,
        at(1),
        f.terminal,
        { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
        at(2),
        controller.signal,
      ),
      (value: unknown) => value === error,
    );
    assert.equal(writes, 1);
    assert.equal((await f.store.lifecycle(f.id))?.readyAt, null);
  });
});

test('readiness returns a committed snapshot after response loss without another write', async () => {
  const f = await fixture();
  const error = new Error('Lost response');
  let writes = 0;
  const client = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as TransactWriteCommand, options as never);
      if (command instanceof TransactWriteCommand) {
        writes++;
        throw error;
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const saved = await new DynamoAttemptStore(client, f.table).ready(
    f.lease,
    at(1),
    f.terminal,
    { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    at(2),
  );
  assert.equal(saved.view.status, 'ready');
  assert.equal(saved.view.readyAt, at(1));
  assert.equal(writes, 1);
  assert.deepEqual(await f.ready(), saved);
  assert.equal((await f.store.lifecycle(f.id))?.readyAt, at(1));
});

test('a leading Monitor clock defers lifecycle decisions without rejecting durable evidence', async () => {
  const f = await fixture();
  await assert.rejects(
    f.store.ready(f.lease, at(1), f.terminal, { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 }, at(0.9)),
    (error: unknown) => error instanceof AttemptStoreError && error.code === 'conflict',
  );
  await f.put('MONITOR_OBSERVATION', { ...f.observation, at: at(2.1) });
  await assert.rejects(f.ready(), (error: unknown) => error instanceof AttemptStoreError && error.code === 'conflict');
  await f.store.ready(
    f.lease,
    at(1),
    f.terminal,
    { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    at(2.1),
  );
  await f.put('RECORDING', { ...f.recording, cursor: 2 });
  await f.put('MONITOR_OBSERVATION', {
    ...f.observation,
    cursor: 2,
    sequence: 2,
    at: at(62),
    recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
  });
  assert.equal(await reconcileFixture(f, 61.9).reconcile(f.id), 'active');
  assert.equal((await f.store.session(f.id))?.view.status, 'ready');
  assert.equal(await reconcileFixture(f, 62).reconcile(f.id), 'draining');
  assert.equal((await f.store.session(f.id))?.view.endedAt, at(62));
});

test('competing outcomes fix one cutoff and drain without releasing the active lock', async () => {
  const f = await fixture();
  await f.ready();
  const outcomes = await Promise.all([
    f.store.outcome(f.id, 'ended', 'learner_ended', at(3), undefined, 'learner-1'),
    f.store.outcome(f.id, 'failed', 'environment_exited', at(4)),
  ]);
  assert.equal(outcomes[0]!.view.status, outcomes[1]!.view.status);
  assert.equal(outcomes[0]!.view.endedAt, outcomes[1]!.view.endedAt);
  const saved = await f.get('RECORDING');
  assert.equal(saved.status, 'draining');
  assert.equal(saved.cutoffAt, outcomes[0]!.view.endedAt);
  assert.equal(Date.parse(saved.drainDeadlineAt) - Date.parse(saved.cutoffAt), 30_000);
  assert.ok(
    (await database.document.send(new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' } })))
      .Item,
  );
  await assert.rejects(
    f.store.outcome(f.id, 'ended', 'learner_ended', at(5), undefined, 'other-user'),
    (error) => error instanceof AttemptStoreError && error.code === 'not_found',
  );
});

test('owner end replays outcomes committed during reads or before its transaction', async (t) => {
  for (const read of ['STATE', 'LIFECYCLE', 'RECORDING']) {
    for (const [status, reason] of [
      ['ended', 'learner_ended'],
      ['failed', 'environment_exited'],
    ] as const) {
      await t.test(`${status} commits after ${read}`, async () => {
        const f = await fixture();
        await f.ready();
        let committed = false;
        const hooked = withReadHook(f, async (key) => {
          if (key === read && !committed) {
            committed = true;
            await f.store.outcome(f.id, status, reason, at(3));
          }
        });
        const requestId = randomUUID();
        const handler = createEndSessionHandler({ store: hooked.store, now: () => new Date(at(4)) });
        const response = await handler(
          {
            httpMethod: 'POST',
            resource: '/v1/sessions/{id}/end',
            pathParameters: { id: f.id },
            requestContext: { authorizer: { claims: { sub: 'learner-1' } } },
            body: JSON.stringify({ requestId }),
            isBase64Encoded: false,
          } as unknown as APIGatewayProxyEvent,
          { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 30_000 },
        );
        assert.equal(response.statusCode, 200, response.body);
        const saved = (await f.store.session(f.id))!;
        assert.equal(saved.view.status, status);
        assert.equal(saved.view.statusReason, reason);
        assert.equal(saved.view.endedAt, at(3));
        assert.deepEqual(JSON.parse(response.body), { session: saved.view });
        assert.equal(hooked.reads.filter((key) => key === 'STATE').length, 2);
        assert.deepEqual(await f.get(`REQUEST#${requestId}`), {
          schemaVersion: 1,
          operation: 'end_session',
          ownerId: 'learner-1',
          requestId,
          sessionId: f.id,
        });
        const expectedWrites = read === 'RECORDING' ? 2 : 1;
        assert.equal(hooked.writes.length, expectedWrites);
        const receiptWrite = hooked.writes.at(-1)!;
        assert.equal(receiptWrite.input.TransactItems?.length, 2);
        assert.equal(receiptWrite.input.TransactItems?.[1]?.Put?.Item?.SK, `REQUEST#${requestId}`);
        const recording = await f.get('RECORDING');
        assert.equal(recording.status, 'draining');
        assert.equal(recording.cutoffAt, at(3));
        assert.equal(recording.drainDeadlineAt, at(33));
        const retry = await hooked.store.outcome(
          f.id,
          'ended',
          'learner_ended',
          at(5),
          undefined,
          'learner-1',
          undefined,
          at(5),
          requestId,
        );
        assert.deepEqual(retry, saved);
        assert.equal(hooked.writes.length, expectedWrites);
        const lock = await database.document.send(
          new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' } }),
        );
        assert.equal(lock.Item?.data.sessionId, f.id);
      });
    }
  }
});

test('outcome retries recorder initialization between reads and fences the unstarted recorder', async () => {
  const f = await fixture();
  await f.put('STATE', {
    ...f.session,
    view: { ...f.session.view, recording: { status: 'pending', reason: null } },
  });
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: f.key('RECORDING') }));
  const recorder = new DynamoMonitorRecordingStore(database.document, f.table);
  let committed = false;
  const hooked = withReadHook(f, async (key) => {
    if (key === 'STATE' && !committed) {
      committed = true;
      await recorder.claim({ sessionId: f.id, recorderId: 'gateway-1', now: at(3) });
    }
  });
  const saved = await hooked.store.outcome(f.id, 'ended', 'learner_ended', at(4), undefined, 'learner-1');
  assert.equal(saved.view.status, 'ended');
  assert.equal(saved.view.endedAt, at(4));
  assert.deepEqual(saved.view.recording, { status: 'incomplete', reason: 'recorder_lost' });
  assert.equal(hooked.reads.filter((key) => key === 'RECORDING').length, 2);
  assert.equal(hooked.writes.length, 1);
  assert.equal((await f.get('RECORDING')).reason, 'recorder_lost');
  assert.equal((await f.get('RECORDING')).recorderId, null);
  assert.equal((await f.get('RECORDING')).startedAt, null);
});

test('end retry preserves atomicity after lease renewals exhaust the transaction budget', async () => {
  const f = await fixture();
  await f.ready();
  const lifecycle = await f.get('LIFECYCLE');
  const recordings = new DynamoMonitorRecordingStore(database.document, f.table);
  let renewals = 0;
  const hooked = withReadHook(f, async (key) => {
    if (key === 'RECORDING' && renewals < 3) {
      // Each actual renewal invalidates the snapshot already read by outcome().
      await recordings.renew(f.lease, at(70 + renewals++), 30_000);
    }
  });
  const requestId = randomUUID();
  let now = 70;
  const handler = createEndSessionHandler({ store: hooked.store, now: () => new Date(at(now)) });
  const event = {
    httpMethod: 'POST',
    resource: '/v1/sessions/{id}/end',
    pathParameters: { id: f.id },
    requestContext: { authorizer: { claims: { sub: 'learner-1' } } },
    body: JSON.stringify({ requestId }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEvent;
  const invoke = () => handler(event, { awsRequestId: randomUUID(), getRemainingTimeInMillis: () => 30_000 });

  const exhausted = await invoke();
  assert.equal(exhausted.statusCode, 500, exhausted.body);
  assert.deepEqual(JSON.parse(exhausted.body), {
    code: 'INTERNAL_ERROR',
    message: 'The session could not be ended. Retry with the same request ID.',
    requestId,
  });
  assert.equal(renewals, 3);
  assert.equal(hooked.writes.length, 3);
  assert.equal((await f.get('STATE')).view.status, 'ready');
  assert.equal((await f.get('STATE')).view.endedAt, null);
  assert.deepEqual(await f.get('LIFECYCLE'), lifecycle);
  assert.equal(await f.get(`REQUEST#${requestId}`), undefined);
  const renewed = await recordings.get(f.id);
  assert.equal(renewed?.status, 'recording');
  assert.equal(renewed?.updatedAt, at(72));
  assert.equal(renewed?.cutoffAt, null);

  now = 74;
  const retried = await invoke();
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(hooked.writes.length, 4);
  const saved = (await f.store.session(f.id))!;
  assert.equal(saved.view.status, 'ended');
  assert.equal(saved.view.statusReason, 'learner_ended');
  assert.equal(saved.view.endedAt, at(74));
  assert.deepEqual(JSON.parse(retried.body), { session: saved.view });
  assert.deepEqual(await f.get(`REQUEST#${requestId}`), {
    schemaVersion: 1,
    operation: 'end_session',
    ownerId: 'learner-1',
    requestId,
    sessionId: f.id,
  });
  assert.equal((await recordings.get(f.id))?.cutoffAt, at(74));
  assert.equal((await recordings.get(f.id))?.drainDeadlineAt, at(104));

  now = 75;
  const duplicate = await invoke();
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.deepEqual(JSON.parse(duplicate.body), JSON.parse(retried.body));
  assert.equal(hooked.writes.length, 4);
  const lock = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' }, ConsistentRead: true }),
  );
  assert.equal(lock.Item?.data.sessionId, f.id);
});

test('persistent session and recording mismatches exhaust three reads without writes', async (t) => {
  for (const mismatch of ['pending-with-recorder', 'recording-without-recorder']) {
    await t.test(mismatch, async () => {
      const f = await fixture();
      if (mismatch === 'pending-with-recorder') {
        await f.put('STATE', {
          ...f.session,
          view: { ...f.session.view, recording: { status: 'pending', reason: null } },
        });
      } else {
        await database.document.send(new DeleteCommand({ TableName: f.table, Key: f.key('RECORDING') }));
      }
      const before = await f.get('STATE');
      const hooked = withReadHook(f);
      await assert.rejects(
        hooked.store.outcome(f.id, 'ended', 'learner_ended', at(3), undefined, 'learner-1'),
        (error) => error instanceof AttemptStoreError && error.code === 'conflict',
      );
      assert.equal(hooked.reads.filter((key) => key === 'STATE').length, 3);
      assert.equal(hooked.reads.filter((key) => key === 'RECORDING').length, 3);
      assert.equal(hooked.writes.length, 0);
      assert.deepEqual(await f.get('STATE'), before);
    });
  }
});

test('mixed snapshot retries preserve cancellation, read errors, and receipt conflicts', async (t) => {
  for (const failure of ['abort', 'read-error', 'receipt-conflict']) {
    await t.test(failure, async () => {
      const f = await fixture();
      await f.ready();
      const requestId = randomUUID();
      const controller = new AbortController();
      const unavailable = new Error('Storage unavailable');
      let sessionReads = 0;
      const hooked = withReadHook(f, async (key) => {
        if (key === 'STATE') {
          sessionReads++;
          if (sessionReads === 1) {
            await f.store.outcome(f.id, 'failed', 'environment_exited', at(3));
          } else if (failure === 'read-error') {
            throw unavailable;
          }
        }
        if (key === 'RECORDING' && failure === 'abort') controller.abort();
        if (key === 'RECORDING' && failure === 'receipt-conflict')
          await f.put(`REQUEST#${requestId}`, { schemaVersion: 1, operation: 'other' });
      });
      await assert.rejects(
        hooked.store.outcome(
          f.id,
          'ended',
          'learner_ended',
          at(4),
          controller.signal,
          'learner-1',
          undefined,
          at(4),
          requestId,
        ),
        (error) =>
          failure === 'abort'
            ? error instanceof Error && error.name === 'AbortError'
            : failure === 'read-error'
              ? error === unavailable
              : error instanceof AttemptStoreError && error.code === 'conflict',
      );
      assert.equal(hooked.writes.length, 0);
      assert.equal((await f.store.session(f.id))?.view.status, 'failed');
      assert.equal((await f.store.session(f.id))?.view.endedAt, at(3));
      if (failure === 'receipt-conflict') {
        assert.equal(sessionReads, 2);
        assert.equal((await f.get(`REQUEST#${requestId}`)).operation, 'other');
      }
    });
  }
});

test('stale timers cannot fail a ready session before its saved time limit', async () => {
  const f = await fixture();
  await f.ready();
  await assert.rejects(
    f.store.outcome(f.id, 'failed', 'time_limit', at(180)),
    (error) => error instanceof AttemptStoreError && error.code === 'conflict',
  );
  assert.equal((await f.store.session(f.id))?.view.status, 'ready');
  await f.store.outcome(f.id, 'failed', 'time_limit', at(1201), undefined, undefined, undefined, at(1202));
  assert.equal((await f.get('RECORDING')).cutoffAt, at(1201));
});

test('readiness cannot publish an attempt at or after its measurement time limit', async () => {
  const f = await fixture();
  await f.put('STATE', {
    ...f.session,
    view: { ...f.session.view, timeLimitSeconds: 60 },
    accessGrant: { ...f.session.accessGrant, timeLimitSeconds: 60 },
  });
  for (const seconds of [61, 62]) {
    await assert.rejects(
      f.store.ready(
        f.lease,
        at(1),
        f.terminal,
        { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
        at(seconds),
      ),
      (error) => error instanceof AttemptStoreError && error.code === 'conflict',
    );
    assert.equal((await f.store.session(f.id))?.view.status, 'provisioning');
    assert.equal((await f.store.lifecycle(f.id))?.readyAt, null);
  }
  const ready = await f.store.ready(
    f.lease,
    at(1),
    f.terminal,
    { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    at(60.999),
  );
  assert.equal(ready.view.endsAt, at(61));
});

test('late end requests save the fixed deadline outcome and a duplicate-safe end receipt', async () => {
  const f = await fixture();
  await f.ready();
  const requestId = randomUUID();
  const result = await f.store.outcome(
    f.id,
    'ended',
    'learner_ended',
    at(1201),
    undefined,
    'learner-1',
    undefined,
    at(1201),
    requestId,
  );
  assert.equal(result.view.status, 'failed');
  assert.equal(result.view.statusReason, 'time_limit');
  assert.equal(result.view.endedAt, at(1201));
  assert.equal((await f.get('RECORDING')).cutoffAt, at(1201));
  assert.equal((await f.get('RECORDING')).drainDeadlineAt, at(1231));
  assert.equal((await f.get(`REQUEST#${requestId}`)).operation, 'end_session');
  const retry = await f.store.outcome(
    f.id,
    'ended',
    'learner_ended',
    at(1300),
    undefined,
    'learner-1',
    undefined,
    at(1300),
    requestId,
  );
  assert.deepEqual(retry, result);
});

test('late non-recovery outcomes use the deadline even with an earlier cutoff or a met snapshot', async () => {
  for (const outcome of [
    { status: 'ended', reason: 'learner_ended' },
    { status: 'abandoned', reason: 'heartbeat_missed' },
    { status: 'error', reason: 'environment_exited' },
  ] as const) {
    const f = await fixture();
    await f.ready();
    const lifecycle = (await f.store.lifecycle(f.id))!;
    const met = {
      ...lifecycle,
      lastMonitorAt: at(61),
      recovery: { state: 'met' as const, sustainedSeconds: 60, requiredSeconds: 60 },
    };
    await f.put('LIFECYCLE', met);
    const result = await f.store.outcome(
      f.id,
      outcome.status,
      outcome.reason,
      at(1200),
      undefined,
      undefined,
      undefined,
      at(1202),
      undefined,
      met,
    );
    assert.equal(result.view.status, 'failed');
    assert.equal(result.view.statusReason, 'time_limit');
    assert.equal(result.view.endedAt, at(1201));
  }
});

test('heartbeat checks input generation, cannot move backward, and does not share recorder renewal', async () => {
  const f = await fixture();
  await f.ready();
  const input = {
    schemaVersion: 1,
    sessionId: f.id,
    connectionId: randomUUID(),
    generation: 1,
    claimedAt: at(2),
  };
  await f.put('INPUT', input);
  await assert.rejects(f.store.heartbeat({ ...input, generation: 2 }, at(20)));
  await f.store.heartbeat(input, at(20));
  await f.store.heartbeat(input, at(10));
  assert.equal((await f.store.lifecycle(f.id))?.lastSeenAt, at(20));
  await assert.rejects(f.store.outcome(f.id, 'abandoned', 'heartbeat_missed', at(300)));
  assert.equal((await f.store.session(f.id))?.view.status, 'ready');
});

test('heartbeat retries pure transaction contention with the same request and preserves generation checks', async () => {
  const f = await fixture();
  await f.ready();
  const input = { schemaVersion: 1, sessionId: f.id, connectionId: randomUUID(), generation: 1, claimedAt: at(2) };
  await f.put('INPUT', input);
  const requests: TransactWriteCommand[] = [];
  const client = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) {
        requests.push(command);
        if (requests.length < 3)
          throw Object.assign(new Error('Conflict'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }, { Code: 'None' }],
          });
      }
      return database.document.send(command as TransactWriteCommand, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoAttemptStore(client, f.table);
  await store.heartbeat(input, at(20));
  assert.equal(requests.length, 3);
  assert.equal(requests[0], requests[1]);
  assert.equal(requests[1], requests[2]);
  assert.equal((await f.store.lifecycle(f.id))?.lastSeenAt, at(20));
  await assert.rejects(store.heartbeat({ ...input, generation: 2 }, at(40)));
  assert.equal(requests.length, 3);
});

test('unchanged failing recovery uses the durable observation without rewriting lifecycle or public state', async () => {
  const f = await fixture();
  await f.ready();
  const previous = await f.store.lifecycle(f.id);
  let writes = 0;
  const client = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) writes++;
      return database.document.send(command as TransactWriteCommand, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoAttemptStore(client, f.table);
  for (let sequence = 2; sequence <= 10; sequence++) {
    await f.put('RECORDING', { ...f.recording, cursor: sequence, leaseExpiresAt: at(400) });
    await f.put('MONITOR_OBSERVATION', { ...f.observation, cursor: sequence, sequence, at: at(sequence * 10) });
    await store.observe(f.id, at(sequence * 10), undefined, f.lease);
  }
  assert.equal(writes, 0);
  assert.deepEqual(await f.store.lifecycle(f.id), previous);
  assert.equal(await reconcileFixture(f, 101).reconcile(f.id), 'active');
  assert.equal((await f.store.session(f.id))?.view.status, 'ready');
});

test('recorder absence and lease churn allow recovery without falsely reporting environment exit', async () => {
  const f = await fixture();
  await f.ready();
  const lifecycle = (await f.store.lifecycle(f.id))!;
  await f.put('LIFECYCLE', { ...lifecycle, lastSeenAt: at(300) });
  for (const seconds of [32, 90, 299]) {
    await f.put('RECORDING', { ...f.recording, generation: seconds, leaseExpiresAt: at(seconds - 1) });
    assert.equal(await reconcileFixture(f, seconds).reconcile(f.id), 'active');
    assert.equal((await f.store.session(f.id))?.view.status, 'ready');
  }
  await f.put('RECORDING', { ...f.recording, generation: 300, leaseExpiresAt: at(400) });
  assert.equal(await reconcileFixture(f, 301).reconcile(f.id), 'draining');
  assert.equal((await f.store.session(f.id))?.view.statusReason, 'recorder_unavailable');
});

test('a recovered observation fences a stale recorder-unavailable outcome', async () => {
  const f = await fixture();
  await f.ready();
  const lifecycle = (await f.store.lifecycle(f.id))!;
  await f.put('LIFECYCLE', { ...lifecycle, lastSeenAt: at(300) });
  await f.put('RECORDING', { ...f.recording, cursor: 2, leaseExpiresAt: at(400) });
  await f.put('MONITOR_OBSERVATION', { ...f.observation, cursor: 2, sequence: 2, at: at(300) });
  await f.store.outcome(f.id, 'error', 'recorder_unavailable', at(301), undefined, undefined, undefined, at(301));
  assert.equal((await f.store.session(f.id))?.view.status, 'ready');
  assert.equal(await reconcileFixture(f, 301).reconcile(f.id), 'active');
  assert.equal((await f.store.lifecycle(f.id))?.lastMonitorAt, at(1));
});

test('sustained monitor recovery fixes an outcome while data gaps keep score unavailable', async () => {
  const f = await fixture();
  await f.ready();
  await f.put('RECORDING', { ...f.recording, cursor: 2 });
  await f.put('MONITOR_OBSERVATION', {
    ...f.observation,
    cursor: 2,
    sequence: 2,
    at: at(61),
    recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
  });
  await f.store.observe(f.id, at(61), undefined, f.lease);
  assert.equal((await f.store.session(f.id))?.view.status, 'resolved');
  await f.store.incomplete(f.id, 'data_gap', at(62));
  assert.equal((await f.store.session(f.id))?.view.recording.status, 'incomplete');
  assert.equal((await f.get('RECORDING')).sealed, null);
  await f.store.cleanup(f.id, at(63), true);
  assert.equal((await f.store.lifecycle(f.id))?.schedulesDeleted, true);
  assert.equal((await f.store.session(f.id))?.view.readyAt, at(1));
});

function reconcileFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  seconds: number,
  taskStatus: string | null = 'RUNNING',
) {
  const calls: string[] = [];
  const reconcile = createReconcileSession({
    sessions: {
      session: async (id) => (await f.store.session(id)) as typeof f.session | undefined,
      saveTask: async (_id, taskArn) => {
        const saved = await f.get('STATE');
        await f.put('STATE', { ...saved, taskArn });
        return { ...saved, taskArn };
      },
    },
    attempts: f.store,
    environment: {
      findActive: async () =>
        taskStatus === 'RUNNING' ? [{ taskArn: f.session.taskArn!, lastStatus: 'RUNNING' }] : [],
      describe: async () => (taskStatus ? { taskArn: f.session.taskArn!, lastStatus: taskStatus } : undefined),
      stop: async () => {
        calls.push('stop');
      },
    },
    schedules: {
      ensure: async () => {
        calls.push('ensure');
      },
      delete: async () => {
        calls.push('delete');
      },
    },
    now: () => new Date(at(seconds)),
  });
  return { reconcile, calls };
}

test('cleanup calls the shared finaliser only after recording and task cleanup are committed', async () => {
  const f = await fixture();
  await f.ready();
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
  let calls = 0;
  const reconcile = createReconcileSession({
    sessions: { session: async () => (await f.get('STATE')) as typeof f.session, saveTask: async () => f.session },
    attempts: f.store,
    environment: {
      findActive: async () => [],
      describe: async () => ({ taskArn: f.session.taskArn!, lastStatus: 'STOPPED' }),
      stop: async () => {
        throw new Error('Stopped task must not restart');
      },
    },
    schedules: { ensure: async () => {}, delete: async () => {} },
    now: () => new Date(at(4)),
    finalise: async (session) => {
      assert.equal(session.view.recording.status, 'incomplete');
      const state = await f.store.lifecycle(f.id);
      assert.ok(state?.taskStoppedAt);
      assert.equal(state?.schedulesDeleted, true);
      calls++;
      if (calls === 1) throw new Error('temporary finaliser failure');
    },
  });
  await assert.rejects(reconcile(f.id), /temporary finaliser failure/);
  assert.equal(await reconcile(f.id), 'cleaned');
  assert.equal(calls, 2);
});

test('reconciliation repairs provisioning and missed recording discovery from the saved task address', async () => {
  const f = await fixture();
  const calls: string[] = [];
  let rejectPublish = true;
  const reconcile = createReconcileSession({
    sessions: {
      session: async (id) => (await f.store.session(id)) as typeof f.session | undefined,
      saveTask: async () => {
        throw new Error('Saved task must not change');
      },
    },
    attempts: f.store,
    provision: async (id) => {
      assert.equal(id, f.id);
      calls.push('provision');
      return f.session;
    },
    publish: async (observation) => {
      assert.deepEqual(observation, {
        sessionId: f.id,
        clusterArn: f.session.launchArguments.cluster,
        taskArn: f.session.taskArn,
        taskAddress: '10.0.1.42',
      });
      calls.push('publish');
      if (rejectPublish) throw new Error('Temporary publication failure');
      return 'published';
    },
    environment: {
      findActive: async () => [],
      describe: async () => ({ taskArn: f.session.taskArn!, lastStatus: 'RUNNING', taskAddress: '10.0.1.42' }),
      stop: async () => {
        throw new Error('Provisioning repair must not stop the saved task');
      },
    },
    schedules: { ensure: async () => {}, delete: async () => {} },
    now: () => new Date(at(2)),
  });
  await assert.rejects(reconcile(f.id), /Temporary publication failure/);
  rejectPublish = false;
  assert.equal(await reconcile(f.id), 'active');
  assert.deepEqual(calls, ['provision', 'publish', 'provision', 'publish']);
});

test('reconciliation replays a committed recovery after worker loss without a live lease', async () => {
  const f = await fixture();
  await f.ready();
  await f.put('RECORDING', { ...f.recording, cursor: 2, leaseExpiresAt: at(60) });
  await f.put('MONITOR_OBSERVATION', {
    ...f.observation,
    cursor: 2,
    sequence: 2,
    at: at(61),
    recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
  });
  const r = reconcileFixture(f, 62);
  assert.equal(await r.reconcile(f.id), 'draining');
  assert.equal((await f.store.session(f.id))?.view.status, 'resolved');
  assert.equal((await f.store.session(f.id))?.view.endedAt, at(61));
  assert.deepEqual(r.calls, []);
});

test('a committed recovery before the deadline can be replayed after the deadline', async () => {
  const f = await fixture();
  await f.ready();
  await f.put('RECORDING', { ...f.recording, cursor: 2, leaseExpiresAt: at(60) });
  await f.put('MONITOR_OBSERVATION', {
    ...f.observation,
    cursor: 2,
    sequence: 2,
    at: at(61),
    recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
  });
  await f.store.observe(f.id, at(1300));
  const saved = (await f.store.session(f.id))!;
  assert.equal(saved.view.status, 'resolved');
  assert.equal(saved.view.endedAt, at(61));
  assert.equal((await f.get('RECORDING')).drainDeadlineAt, at(91));
});

test('recovery at or after the deadline cannot win over the time limit', async () => {
  for (const seconds of [1201, 1202]) {
    const f = await fixture();
    await f.ready();
    await f.put('RECORDING', { ...f.recording, cursor: 2, leaseExpiresAt: at(60) });
    await f.put('MONITOR_OBSERVATION', {
      ...f.observation,
      cursor: 2,
      sequence: 2,
      at: at(seconds),
      recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
    });
    await f.store.observe(f.id, at(1300));
    const saved = (await f.store.session(f.id))!;
    assert.equal(saved.view.status, 'failed');
    assert.equal(saved.view.statusReason, 'time_limit');
    assert.equal(saved.view.endedAt, at(1201));
  }
});

test('stale recovery snapshots cannot override a concurrent outcome', async () => {
  const f = await fixture();
  await f.ready();
  const original = (await f.store.lifecycle(f.id))!;
  const met = {
    ...original,
    lastMonitorAt: at(61),
    recovery: { state: 'met' as const, sustainedSeconds: 60, requiredSeconds: 60 },
  };
  await f.put('LIFECYCLE', met);
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(62));
  const saved = await f.store.outcome(
    f.id,
    'resolved',
    'validators_passed',
    at(61),
    undefined,
    undefined,
    undefined,
    at(1300),
    undefined,
    met,
  );
  assert.equal(saved.view.status, 'ended');
  assert.equal(saved.view.endedAt, at(62));
});

test('drain timeout precedes task stop and ready cleanup keeps the active lock', async () => {
  const f = await fixture();
  await f.ready();
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
  assert.equal(await reconcileFixture(f, 4).reconcile(f.id), 'draining');
  const stopping = reconcileFixture(f, 33);
  assert.equal(await stopping.reconcile(f.id), 'cleanup_pending');
  assert.equal((await f.store.session(f.id))?.view.recording.status, 'incomplete');
  assert.deepEqual(stopping.calls, ['stop']);
  const stopped = reconcileFixture(f, 34, 'STOPPED');
  assert.equal(await stopped.reconcile(f.id), 'cleaned');
  assert.deepEqual(stopped.calls, ['delete']);
  const lock = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' } }),
  );
  assert.equal(lock.Item?.data.sessionId, f.id);
  assert.equal(await stopped.reconcile(f.id), 'cleaned');
});

test('durable coverage permits task cleanup during sealing and survives task stop', async () => {
  const f = await fixture();
  await f.ready();
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
  const coveredAt = at(4);
  const coverage = {
    schemaVersion: 1,
    sessionId: f.id,
    cutoffAt: at(3),
    coveredAt,
    taskDrainDeadlineAt: at(33),
    sealingDeadlineAt: at(86_404),
    terminal: { ...f.terminal, metadata: { ...f.terminal.metadata, observedAt: coveredAt } },
    monitor: {
      phase: 'sealed',
      source: null,
      after: 0,
      nextSequence: 0,
      frameCount: 0,
      sha256: 'a'.repeat(64),
      objectKey: `sessions/${f.id}/metrics/000000001/sealed/empty/000000-000000-${'a'.repeat(64)}.json`,
    },
    final: {
      type: 'metrics',
      sample: { at: at(3), values: { request_rate: 1 } },
      counters: { totalRequests: 1, failedRequests: 1 },
      recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    },
  };
  await f.put('RECORDING_COVERAGE', coverage);
  await f.put('RECORDING', { ...(await f.get('RECORDING')), drainDeadlineAt: coverage.sealingDeadlineAt });
  const stopping = reconcileFixture(f, 5);
  assert.equal(await stopping.reconcile(f.id), 'cleanup_pending');
  assert.deepEqual(stopping.calls, ['stop']);
  const stopped = reconcileFixture(f, 40, 'STOPPED');
  assert.equal(await stopped.reconcile(f.id), 'draining');
  assert.deepEqual(stopped.calls, ['delete']);
  assert.equal((await f.store.lifecycle(f.id))?.taskStoppedAt, at(40));
  assert.equal((await f.store.session(f.id))?.view.recording.status, 'draining');
  await f.store.incomplete(f.id, 'task_lost', at(41));
  assert.equal((await f.store.session(f.id))?.view.recording.status, 'draining');
  await assert.rejects(f.store.incomplete(f.id, 'drain_timeout', at(43)));
  assert.equal(await reconcileFixture(f, 86_404, 'STOPPED').reconcile(f.id), 'cleaned');
  assert.equal((await f.store.session(f.id))?.view.recording.reason, 'drain_timeout');
});

test('a missing known task is not confirmed cleanup', async () => {
  const f = await fixture();
  await f.ready();
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
  await f.store.incomplete(f.id, 'data_gap', at(4));
  const r = reconcileFixture(f, 1000, null);
  assert.equal(await r.reconcile(f.id), 'cleanup_pending');
  assert.equal((await f.store.lifecycle(f.id))?.taskStoppedAt, null);
});

test('cleanup retries preserve stop confirmation after timer deletion failure', async () => {
  const f = await fixture();
  await f.ready();
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
  await f.store.incomplete(f.id, 'data_gap', at(4));
  const calls: string[] = [];
  let failDelete = true;
  const reconcile = createReconcileSession({
    sessions: {
      session: async (id) => (await f.store.session(id)) as typeof f.session | undefined,
      saveTask: async () => {
        throw new Error('Task already saved');
      },
    },
    attempts: f.store,
    environment: {
      findActive: async () => [],
      describe: async () => {
        calls.push('describe');
        return { taskArn: f.session.taskArn!, lastStatus: 'STOPPED' };
      },
      stop: async () => {
        throw new Error('Stopped task must not be stopped again');
      },
    },
    schedules: {
      ensure: async () => {},
      delete: async () => {
        calls.push('delete');
        if (failDelete) throw new Error('Temporary schedule failure');
      },
    },
    now: () => new Date(at(5)),
  });
  await assert.rejects(reconcile(f.id), /Temporary schedule failure/);
  assert.equal((await f.store.lifecycle(f.id))?.taskStoppedAt, at(5));
  assert.equal((await f.store.lifecycle(f.id))?.schedulesDeleted, false);
  failDelete = false;
  assert.equal(await reconcile(f.id), 'cleaned');
  assert.deepEqual(calls, ['describe', 'delete', 'delete']);
  assert.equal((await f.store.lifecycle(f.id))?.schedulesDeleted, true);
});

test('a failed task stop keeps cleanup pending and cannot release the learner lock', async () => {
  const f = await fixture();
  await f.ready();
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(3));
  await f.store.incomplete(f.id, 'data_gap', at(4));
  const reconcile = createReconcileSession({
    sessions: {
      session: async (id) => (await f.store.session(id)) as typeof f.session | undefined,
      saveTask: async () => f.session,
    },
    attempts: f.store,
    environment: {
      findActive: async () => [],
      describe: async () => ({ taskArn: f.session.taskArn!, lastStatus: 'RUNNING' }),
      stop: async () => {
        throw new Error('Temporary stop failure');
      },
    },
    schedules: {
      ensure: async () => {},
      delete: async () => {
        throw new Error('Schedules must remain until stop confirmation');
      },
    },
    now: () => new Date(at(5)),
  });
  await assert.rejects(reconcile(f.id), /Temporary stop failure/);
  assert.equal((await f.store.lifecycle(f.id))?.taskStoppedAt, null);
  const lock = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' } }),
  );
  assert.equal(lock.Item?.data.sessionId, f.id);
});

test('never-ready retirement cannot delete a lock held by another session', async () => {
  const f = await fixture();
  await f.put('RECORDING', { ...f.recording, startedAt: null, source: null, cursor: 0 });
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(2));
  const other = randomUUID();
  await database.document.send(
    new PutCommand({ TableName: f.table, Item: { PK: 'USER#learner-1', SK: 'ACTIVE', data: { sessionId: other } } }),
  );
  assert.equal(await reconcileFixture(f, 4, 'STOPPED').reconcile(f.id), 'cleaned');
  await f.store.completeNeverReady(f.id, at(5));
  const lock = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' } }),
  );
  assert.equal(lock.Item?.data.sessionId, other);
});

test('never-ready end before monitor start fences recording then releases only its own lock', async () => {
  const f = await fixture();
  await f.put('RECORDING', { ...f.recording, startedAt: null, source: null, cursor: 0 });
  await f.store.outcome(f.id, 'ended', 'learner_ended', at(2));
  assert.equal((await f.get('RECORDING')).status, 'incomplete');
  const r = reconcileFixture(f, 4, 'STOPPED');
  assert.equal(await r.reconcile(f.id), 'cleaned');
  const lock = await database.document.send(
    new GetCommand({ TableName: f.table, Key: { PK: 'USER#learner-1', SK: 'ACTIVE' } }),
  );
  assert.equal(lock.Item, undefined);
  const work = await database.document.send(new GetCommand({ TableName: f.table, Key: f.key('LIFECYCLE') }));
  assert.equal(work.Item?.WorkPK, undefined);
});

test('end receipts survive response loss, duplicate requests, and competing outcomes', async () => {
  const f = await fixture();
  await f.ready();
  const requestId = randomUUID();
  let lost = false;
  const client = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as TransactWriteCommand, options as never);
      if (command instanceof TransactWriteCommand && !lost) {
        lost = true;
        throw new Error('Response lost');
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoAttemptStore(client, f.table);
  const first = await store.outcome(
    f.id,
    'ended',
    'learner_ended',
    at(3),
    undefined,
    'learner-1',
    undefined,
    at(3),
    requestId,
  );
  const retry = await store.outcome(
    f.id,
    'ended',
    'learner_ended',
    at(4),
    undefined,
    'learner-1',
    undefined,
    at(4),
    requestId,
  );
  assert.equal(first.view.endedAt, retry.view.endedAt);
  assert.equal((await f.get(`REQUEST#${requestId}`)).operation, 'end_session');
  await f.put(`REQUEST#${requestId}`, { schemaVersion: 1, operation: 'other' });
  await assert.rejects(
    store.outcome(f.id, 'ended', 'learner_ended', at(4), undefined, 'learner-1', undefined, at(4), requestId),
    (error) => error instanceof AttemptStoreError && error.code === 'conflict',
  );
});

test('malformed public and private session relationships are rejected before effects', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.session, view: { ...f.session.view, statusReason: 'time_limit' } },
    { ...f.session, accessGrant: { ...f.session.accessGrant, timeLimitSeconds: 1800 } },
    { ...f.session, view: { ...f.session.view, hints: { ...f.session.view.hints, remaining: 1 } } },
    {
      ...f.session,
      view: { ...f.session.view, assistance: { ...f.session.view.assistance, hintsReleased: 1 } },
    },
    {
      ...f.session,
      hintPlan: [
        { id: 'read-proxy-error', minElapsedMinutes: 6 },
        { id: 'compare-listeners', minElapsedMinutes: 3 },
      ],
    },
    { ...f.session, taskAddress: 'not-an-ip' },
    ...(
      [
        ['resolved', 'validators_passed'],
        ['failed', 'time_limit'],
        ['abandoned', 'heartbeat_missed'],
      ] as const
    ).map(([status, statusReason]) => ({
      ...f.session,
      view: { ...f.session.view, status, statusReason, endedAt: at(2) },
    })),
  ]) {
    await f.put('STATE', value);
    await assert.rejects(f.ready(), (error) => error instanceof AttemptStoreError && error.code === 'invalid_store');
  }
});

test('a terminal outcome committed during observation reads is preserved without a store error', async (t) => {
  for (const read of ['STATE', 'LIFECYCLE', 'MONITOR_OBSERVATION']) {
    await t.test(read, async () => {
      const f = await fixture();
      await f.ready();
      let ended = false;
      const hooked = withReadHook(f, async (key) => {
        if (key !== read || ended) return;
        ended = true;
        await f.store.outcome(f.id, 'ended', 'learner_ended', at(3), undefined, 'learner-1');
      });
      await hooked.store.observe(f.id, at(4));
      assert.equal(ended, true);
      const saved = await f.store.session(f.id);
      assert.equal(saved?.view.status, 'ended');
      assert.equal(saved?.view.endedAt, at(3));
      assert.equal((await f.get('RECORDING')).cutoffAt, at(3));
      assert.equal(hooked.writes.length, 0);
    });
  }
});

test('impossible recovery time is rejected and stale liveness cannot end a renewed attempt', async () => {
  const f = await fixture();
  await f.ready();
  await f.put('MONITOR_OBSERVATION', {
    ...f.observation,
    at: at(3),
    recovery: { state: 'met', sustainedSeconds: 60, requiredSeconds: 60 },
  });
  await assert.rejects(
    f.store.observe(f.id, at(3)),
    (error) => error instanceof AttemptStoreError && error.code === 'invalid_store',
  );
  const previous = (await f.store.lifecycle(f.id))!;
  await f.put('LIFECYCLE', { ...previous, lastSeenAt: at(310) });
  await f.store.outcome(
    f.id,
    'abandoned',
    'heartbeat_missed',
    at(311),
    undefined,
    undefined,
    undefined,
    at(311),
    undefined,
    previous,
  );
  assert.equal((await f.store.session(f.id))?.view.status, 'ready');
});
