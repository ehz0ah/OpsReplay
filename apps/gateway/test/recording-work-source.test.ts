import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { generate } from 'selfsigned';
import { recordingWorkOrder, unfinishedWorkIndex } from '../../../packages/contracts/private/recording-work.js';
import { DynamoRecordingWorkSource, RecordingWorkSourceError } from '../src/recording-work-source.js';

const now = '2026-10-08T00:00:10.000Z';
const createdAt = '2026-10-08T00:00:00.000Z';

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

function identity(sessionId: string) {
  return {
    PK: `SESSION#${sessionId}`,
    SK: 'STATE',
    [unfinishedWorkIndex.partitionKey]: unfinishedWorkIndex.recordingPartition,
    [unfinishedWorkIndex.sortKey]: recordingWorkOrder(createdAt, sessionId),
  };
}

function session(
  sessionId: string,
  monitorCertificate: string,
  overrides: {
    status?: string;
    recordingStatus?: string;
    provisioningDeadline?: string;
  } = {},
) {
  return {
    ...identity(sessionId),
    data: {
      view: {
        id: sessionId,
        createdAt,
        status: overrides.status ?? 'provisioning',
        recording: { status: overrides.recordingStatus ?? 'pending' },
      },
      provisioningDeadline: overrides.provisioningDeadline ?? '2026-10-08T00:03:00.000Z',
      monitorSecret: 's'.repeat(43),
      monitorCertificate,
      taskAddress: '10.0.1.42',
    },
  };
}

function recording(sessionId: string, recorderId: string, leaseExpiresAt: string) {
  return {
    PK: `SESSION#${sessionId}`,
    SK: 'RECORDING',
    data: {
      schemaVersion: 1,
      status: 'recording',
      recorderId,
      generation: 1,
      leaseExpiresAt,
      startedAt: null,
      source: null,
      cursor: 0,
      cutoffAt: null,
      drainDeadlineAt: null,
      sealed: null,
      reason: null,
      updatedAt: createdAt,
      completedAt: null,
    },
  };
}

test('uses the sparse index as a hint and strongly reads one authoritative session', async () => {
  const activeSessionId = randomUUID();
  const sessionId = randomUUID();
  const cert = await certificate();
  const calls: unknown[] = [];
  const client = {
    send: async (command: unknown, options: unknown) => {
      calls.push({ command, options });
      if (command instanceof QueryCommand) {
        assert.equal(command.input.IndexName, unfinishedWorkIndex.name);
        assert.equal(command.input.ConsistentRead, undefined);
        assert.equal(command.input.Limit, 2);
        return { Items: [identity(activeSessionId), identity(sessionId)] };
      }
      assert.ok(command instanceof BatchGetCommand);
      assert.equal(command.input.RequestItems?.['test-sessions']?.ConsistentRead, true);
      assert.deepEqual(command.input.RequestItems?.['test-sessions']?.Keys, [
        { PK: `SESSION#${sessionId}`, SK: 'STATE' },
        { PK: `SESSION#${sessionId}`, SK: 'RECORDING' },
      ]);
      return { Responses: { 'test-sessions': [session(sessionId, cert)] } };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');
  const signal = AbortSignal.timeout(1_000);

  assert.deepEqual(await source.discover({ limit: 1, excludedSessionIds: [activeSessionId], now }, signal), {
    work: [
      {
        sessionId,
        workOrder: recordingWorkOrder(createdAt, sessionId),
        taskAddress: '10.0.1.42',
        monitorCertificate: cert,
        monitorSecret: 's'.repeat(43),
      },
    ],
    invalidEntries: 0,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[1] as { options: unknown }).options, { abortSignal: signal });
});

test('retires terminal work and leaves expiry to the lifecycle action', async () => {
  const terminalId = randomUUID();
  const expiredId = randomUUID();
  const cert = await certificate();
  const rows = new Map<string, Record<string, unknown>>([
    [terminalId, session(terminalId, cert, { status: 'resolved', recordingStatus: 'complete' })],
    [expiredId, session(expiredId, cert, { provisioningDeadline: now })],
  ]);
  const retired: string[] = [];
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [identity(terminalId), identity(expiredId)] };
      if (command instanceof BatchGetCommand) {
        return { Responses: { 'test-sessions': [...rows.values()] } };
      }
      assert.ok(command instanceof UpdateCommand);
      const sessionId = String(command.input.Key?.PK).slice('SESSION#'.length);
      retired.push(sessionId);
      const row = rows.get(sessionId)!;
      delete row[unfinishedWorkIndex.partitionKey];
      delete row[unfinishedWorkIndex.sortKey];
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  assert.deepEqual(await source.discover({ limit: 2, excludedSessionIds: [], now }), {
    work: [],
    invalidEntries: 0,
  });
  assert.deepEqual(retired, [terminalId]);
});

test('reports an active session with a terminal recording as invalid instead of retiring it', async () => {
  const sessionId = randomUUID();
  const cert = await certificate();
  const invalid = session(sessionId, cert, { status: 'ready', recordingStatus: 'complete' });
  let updates = 0;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) return { Items: [identity(sessionId)] };
      if (command instanceof BatchGetCommand) return { Responses: { 'test-sessions': [invalid] } };
      if (command instanceof GetCommand) return { Item: invalid };
      updates++;
      assert.fail('Invalid work must not be retired');
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');
  const workIdentity = { sessionId, workOrder: recordingWorkOrder(createdAt, sessionId) };

  assert.deepEqual(await source.discover({ limit: 1, excludedSessionIds: [], now }), {
    work: [],
    invalidEntries: 1,
  });
  await assert.rejects(
    source.retire(workIdentity),
    (error: unknown) => error instanceof RecordingWorkSourceError && error.code === 'invalid_store',
  );
  assert.equal(updates, 0);
});

test('advances its bounded query cursor after one malformed page', async () => {
  const invalidId = randomUUID();
  const validId = randomUUID();
  const cert = await certificate();
  const cursor = { ...identity(invalidId) };
  let queries = 0;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) {
        queries++;
        if (queries === 1) {
          assert.equal(command.input.ExclusiveStartKey, undefined);
          return { Items: [{ ...identity(invalidId), PK: 'invalid' }], LastEvaluatedKey: cursor };
        }
        assert.deepEqual(command.input.ExclusiveStartKey, cursor);
        return { Items: [identity(validId)] };
      }
      assert.ok(command instanceof BatchGetCommand);
      return { Responses: { 'test-sessions': [session(validId, cert)] } };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  assert.deepEqual(await source.discover({ limit: 1, excludedSessionIds: [], now }), {
    work: [],
    invalidEntries: 1,
  });
  assert.equal((await source.discover({ limit: 1, excludedSessionIds: [], now })).work[0]?.sessionId, validId);
});

test('an uncertain retire response is accepted only after a strong read proves removal', async () => {
  const sessionId = randomUUID();
  const cert = await certificate();
  const terminal = session(sessionId, cert, { status: 'resolved', recordingStatus: 'complete' });
  let removed = false;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetCommand) {
        assert.equal(command.input.ConsistentRead, true);
        return { Item: removed ? { PK: `SESSION#${sessionId}`, SK: 'STATE' } : terminal };
      }
      if (command instanceof UpdateCommand) {
        removed = true;
        throw new Error('Response lost');
      }
      assert.fail('Unexpected command');
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  assert.equal(await source.retire({ sessionId, workOrder: recordingWorkOrder(createdAt, sessionId) }), 'retired');
  assert.equal(removed, true);
});

test('does not retire work after another gateway changes the authoritative state', async () => {
  const sessionId = randomUUID();
  const cert = await certificate();
  const terminal = session(sessionId, cert, { status: 'resolved', recordingStatus: 'complete' });
  const active = session(sessionId, cert, { status: 'ready', recordingStatus: 'recording' });
  let reads = 0;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetCommand) {
        reads++;
        assert.equal(command.input.ProjectionExpression, undefined);
        return { Item: reads === 1 ? terminal : active };
      }
      assert.ok(command instanceof UpdateCommand);
      assert.match(command.input.ConditionExpression!, /#data\.#view\.#status = :sessionStatus/);
      assert.match(command.input.ConditionExpression!, /#recording\.#status = :recordingStatus/);
      const error = new Error('state changed');
      error.name = 'ConditionalCheckFailedException';
      throw error;
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  assert.equal(await source.retire({ sessionId, workOrder: recordingWorkOrder(createdAt, sessionId) }), 'not_terminal');
  assert.equal(reads, 2);
});

test('returns valid work after a malformed entry on the final query page', async () => {
  const invalidId = randomUUID();
  const validId = randomUUID();
  const cert = await certificate();
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [identity(invalidId), identity(validId)] };
      }
      assert.ok(command instanceof BatchGetCommand);
      const requestedSessionId = String(command.input.RequestItems?.['test-sessions']?.Keys?.[0]?.PK).slice(
        'SESSION#'.length,
      );
      if (requestedSessionId === invalidId) {
        const malformed = session(invalidId, cert);
        malformed.data.taskAddress = ['10.0.1.42'] as unknown as string;
        malformed.data.monitorSecret = ['s'.repeat(43)] as unknown as string;
        return { Responses: { 'test-sessions': [malformed] } };
      }
      return { Responses: { 'test-sessions': [session(validId, cert)] } };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  const result = await source.discover({ limit: 1, excludedSessionIds: [], now });
  assert.equal(result.invalidEntries, 1);
  assert.equal(result.work[0]?.sessionId, validId);
});

test('skips a live lease held by another gateway but permits owned and expired leases', async () => {
  const foreignId = randomUUID();
  const ownedId = randomUUID();
  const expiredId = randomUUID();
  const cert = await certificate();
  const items = [foreignId, ownedId, expiredId].flatMap((sessionId) => [
    session(sessionId, cert, { status: 'ready', recordingStatus: 'recording' }),
    recording(
      sessionId,
      sessionId === ownedId ? 'gateway-1' : 'gateway-2',
      sessionId === expiredId ? now : '2026-10-08T00:00:20.000Z',
    ),
  ]);
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) {
        return { Items: [identity(foreignId), identity(ownedId), identity(expiredId)] };
      }
      assert.ok(command instanceof BatchGetCommand);
      return { Responses: { 'test-sessions': items } };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  const result = await source.discover({ limit: 3, excludedSessionIds: [], now });
  assert.deepEqual(
    result.work.map((item) => item.sessionId),
    [ownedId, expiredId],
  );
  assert.equal(result.invalidEntries, 0);
});

test('resumes after the last inspected item when a page contains more work than the limit', async () => {
  const firstId = randomUUID();
  const secondId = randomUUID();
  const thirdId = randomUUID();
  const cert = await certificate();
  const rows = new Map<string, ReturnType<typeof session>>([
    [firstId, session(firstId, cert)],
    [secondId, session(secondId, cert)],
    [thirdId, session(thirdId, cert)],
  ]);
  let queries = 0;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) {
        queries++;
        if (queries === 1) {
          assert.equal(command.input.ExclusiveStartKey, undefined);
          return {
            Items: [identity(firstId), identity(secondId), identity(thirdId)],
            LastEvaluatedKey: identity(thirdId),
          };
        }
        assert.deepEqual(command.input.ExclusiveStartKey, identity(firstId));
        return { Items: [identity(secondId), identity(thirdId)] };
      }
      assert.ok(command instanceof BatchGetCommand);
      const sessionId = String(command.input.RequestItems?.['test-sessions']?.Keys?.[0]?.PK).slice('SESSION#'.length);
      return { Responses: { 'test-sessions': [rows.get(sessionId)!] } };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  assert.equal((await source.discover({ limit: 1, excludedSessionIds: [], now })).work[0]?.sessionId, firstId);
  assert.equal((await source.discover({ limit: 1, excludedSessionIds: [], now })).work[0]?.sessionId, secondId);
});

test('does not advance discovery when DynamoDB leaves batch keys unprocessed', async () => {
  const sessionId = randomUUID();
  let queries = 0;
  const client = {
    send: async (command: unknown) => {
      if (command instanceof QueryCommand) {
        queries++;
        assert.equal(command.input.ExclusiveStartKey, undefined);
        return { Items: [identity(sessionId)] };
      }
      assert.ok(command instanceof BatchGetCommand);
      return {
        UnprocessedKeys: {
          'test-sessions': { Keys: [{ PK: `SESSION#${sessionId}`, SK: 'STATE' }] },
        },
      };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');

  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      source.discover({ limit: 1, excludedSessionIds: [], now }),
      (error: unknown) => error instanceof RecordingWorkSourceError && error.code === 'unavailable',
    );
  }
  assert.equal(queries, 2);
});

test('skips malformed work and rejects concurrent discovery', async () => {
  const sessionId = randomUUID();
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    send: async (command: unknown) => {
      assert.ok(command instanceof QueryCommand);
      await blocked;
      return { Items: [{ ...identity(sessionId), PK: 'invalid' }] };
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');
  const first = source.discover({ limit: 1, excludedSessionIds: [], now });
  await assert.rejects(
    source.discover({ limit: 1, excludedSessionIds: [], now }),
    (error: unknown) => error instanceof RecordingWorkSourceError && error.code === 'invalid_state',
  );
  release!();
  assert.deepEqual(await first, { work: [], invalidEntries: 1 });
});

test('rejects invalid discovery bounds before reading DynamoDB', async () => {
  let calls = 0;
  const client = {
    send: async () => {
      calls++;
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  const source = new DynamoRecordingWorkSource(client, 'test-sessions', 'gateway-1');
  const sessionId = randomUUID();

  for (const request of [
    { limit: 0, excludedSessionIds: [], now },
    { limit: 65, excludedSessionIds: [], now },
    { limit: 1, excludedSessionIds: Array.from({ length: 129 }, () => randomUUID()), now },
    { limit: 1, excludedSessionIds: [sessionId, sessionId], now },
    { limit: 1, excludedSessionIds: ['not-a-session'], now },
    { limit: 1, excludedSessionIds: [], now: 'not-a-time' },
  ]) {
    await assert.rejects(
      source.discover(request),
      (error: unknown) => error instanceof RecordingWorkSourceError && error.code === 'invalid_input',
    );
  }
  assert.equal(calls, 0);
  assert.throws(
    () => new DynamoRecordingWorkSource(client, 'test-sessions', 'invalid recorder'),
    (error: unknown) => error instanceof RecordingWorkSourceError && error.code === 'invalid_config',
  );
});
