import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  terminalAccessLimits,
  terminalInputKey,
  terminalSessionKey,
  terminalTicketHash,
  terminalTicketKey,
  type TerminalInputRecord,
  type TerminalTicketRecord,
} from '../../../packages/contracts/private/terminal-access.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import { DynamoTerminalAdmissionStore, TerminalAdmissionError } from '../src/terminal-admission-store.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

const now = '2026-10-10T08:00:00.000Z';
const later = '2026-10-10T08:01:00.000Z';
const ownerId = 'learner-1';
const ticketA = 'a'.repeat(43);
const ticketB = 'b'.repeat(43);

function admissionError(code: TerminalAdmissionError['code']) {
  return (error: unknown) => error instanceof TerminalAdmissionError && error.code === code;
}

async function fixture(status = 'ready', taskAddress: string | null = '10.0.1.42') {
  const table = `test-${randomUUID()}`;
  const sessionId = randomUUID();
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
  await database.document.send(
    new PutCommand({
      TableName: table,
      Item: {
        ...terminalSessionKey(sessionId),
        data: { ownerId, view: { id: sessionId, status }, taskAddress },
      },
    }),
  );
  const putTicket = async (ticket: string, expiresAt = later, ticketOwner = ownerId) => {
    const data: TerminalTicketRecord = { schemaVersion: 1, sessionId, ownerId: ticketOwner, expiresAt };
    await database.document.send(
      new PutCommand({
        TableName: table,
        Item: { ...terminalTicketKey(sessionId, terminalTicketHash(ticket)), data },
      }),
    );
  };
  const input = async () =>
    (
      await database.document.send(
        new GetCommand({ TableName: table, Key: terminalInputKey(sessionId), ConsistentRead: true }),
      )
    ).Item?.data as TerminalInputRecord | undefined;
  const ticket = async (value: string) =>
    (
      await database.document.send(
        new GetCommand({
          TableName: table,
          Key: terminalTicketKey(sessionId, terminalTicketHash(value)),
          ConsistentRead: true,
        }),
      )
    ).Item?.data as TerminalTicketRecord | undefined;
  return {
    table,
    sessionId,
    store: new DynamoTerminalAdmissionStore(database.document, table),
    putTicket,
    input,
    ticket,
  };
}

function request(sessionId: string, ticket = ticketA, connectionId = 'gateway-connection-1') {
  return { sessionId, ticket, connectionId, now };
}

test('atomically consumes a ticket and claims the first input generation', async () => {
  const f = await fixture();
  await f.putTicket(ticketA);

  assert.deepEqual(await f.store.admit(request(f.sessionId)), {
    sessionId: f.sessionId,
    taskAddress: '10.0.1.42',
    connectionId: 'gateway-connection-1',
    generation: 1,
  });
  assert.equal(await f.ticket(ticketA), undefined);
  assert.deepEqual(await f.input(), {
    schemaVersion: 1,
    sessionId: f.sessionId,
    generation: 1,
    connectionId: 'gateway-connection-1',
    claimedAt: now,
  });
  await f.store.authorizeInput({ sessionId: f.sessionId, connectionId: 'gateway-connection-1', generation: 1 });
});

test('allows exactly one concurrent use of a single-use ticket', async () => {
  const f = await fixture();
  await f.putTicket(ticketA);

  const results = await Promise.allSettled([
    f.store.admit(request(f.sessionId, ticketA, 'gateway-connection-1')),
    f.store.admit(request(f.sessionId, ticketA, 'gateway-connection-2')),
  ]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(admissionError('auth_failed')(rejected[0]!.reason));
  assert.equal((await f.input())?.generation, 1);
});

test('serializes concurrent tickets into monotonic generations', async () => {
  const f = await fixture();
  await Promise.all([f.putTicket(ticketA), f.putTicket(ticketB)]);

  const results = await Promise.all([
    f.store.admit(request(f.sessionId, ticketA, 'gateway-connection-1')),
    f.store.admit(request(f.sessionId, ticketB, 'gateway-connection-2')),
  ]);
  assert.deepEqual(results.map(({ generation }) => generation).sort(), [1, 2]);
  const input = await f.input();
  assert.equal(input?.generation, 2);
  const winner = results.find(({ generation }) => generation === 2)!;
  assert.equal(input?.connectionId, winner.connectionId);
});

test('recovers a committed admission after its response is lost', async () => {
  const f = await fixture();
  await f.putTicket(ticketA);
  let lost = false;
  const client = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as never, options as never);
      if (!lost && command instanceof TransactWriteCommand) {
        lost = true;
        throw Object.assign(new Error('response lost'), { name: 'TimeoutError' });
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoTerminalAdmissionStore(client, f.table);

  assert.equal((await store.admit(request(f.sessionId))).generation, 1);
  assert.equal(lost, true);
  assert.equal(await f.ticket(ticketA), undefined);
  assert.equal((await f.input())?.connectionId, 'gateway-connection-1');
});

test('retries the exact transaction after a failure known not to have reached DynamoDB', async () => {
  const f = await fixture();
  await f.putTicket(ticketA);
  let writes = 0;
  const client = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) {
        writes++;
        if (writes === 1) throw Object.assign(new Error('request did not leave the process'), { name: 'TimeoutError' });
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoTerminalAdmissionStore(client, f.table);

  assert.equal((await store.admit(request(f.sessionId))).generation, 1);
  assert.equal(writes, 2);
});

test('restarts admission after DynamoDB reports a transaction conflict cancellation reason', async () => {
  const f = await fixture();
  await f.putTicket(ticketA);
  let writes = 0;
  const client = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) {
        writes++;
        if (writes === 1) {
          throw Object.assign(new Error('transaction conflicted'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'None' }, { Code: 'None' }, { Code: 'TransactionConflict' }],
          });
        }
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;
  const store = new DynamoTerminalAdmissionStore(client, f.table);

  assert.equal((await store.admit(request(f.sessionId))).generation, 1);
  assert.equal(writes, 2);
});

test('rejects invalid, expired, non-ready, and terminal admissions without consuming a valid ticket', async () => {
  const missing = await fixture();
  await assert.rejects(missing.store.admit(request(missing.sessionId)), admissionError('auth_failed'));

  const expired = await fixture();
  await expired.putTicket(ticketA, now);
  await assert.rejects(expired.store.admit(request(expired.sessionId)), admissionError('ticket_expired'));
  assert.ok(await expired.ticket(ticketA));

  const provisioning = await fixture('provisioning');
  await provisioning.putTicket(ticketA);
  await assert.rejects(provisioning.store.admit(request(provisioning.sessionId)), admissionError('session_not_ready'));
  assert.ok(await provisioning.ticket(ticketA));

  const terminal = await fixture('resolved');
  await terminal.putTicket(ticketA);
  await assert.rejects(terminal.store.admit(request(terminal.sessionId)), admissionError('session_terminal'));
  assert.ok(await terminal.ticket(ticketA));
});

test('fails closed for inconsistent ownership, task state, and input state', async () => {
  const wrongOwner = await fixture();
  await wrongOwner.putTicket(ticketA, later, 'other-learner');
  await assert.rejects(wrongOwner.store.admit(request(wrongOwner.sessionId)), admissionError('invalid_store'));

  const missingAddress = await fixture('ready', null);
  await missingAddress.putTicket(ticketA);
  await assert.rejects(missingAddress.store.admit(request(missingAddress.sessionId)), admissionError('invalid_store'));

  const exhausted = await fixture();
  await exhausted.putTicket(ticketA);
  await database.document.send(
    new PutCommand({
      TableName: exhausted.table,
      Item: {
        ...terminalInputKey(exhausted.sessionId),
        data: {
          schemaVersion: 1,
          sessionId: exhausted.sessionId,
          generation: terminalAccessLimits.maximumGeneration,
          connectionId: 'old-connection',
          claimedAt: now,
        },
      },
    }),
  );
  await assert.rejects(exhausted.store.admit(request(exhausted.sessionId)), admissionError('generation_exhausted'));
  assert.ok(await exhausted.ticket(ticketA));
});

test('authorizes only the current ready-session input owner', async () => {
  const f = await fixture();
  await f.putTicket(ticketA);
  const admitted = await f.store.admit(request(f.sessionId));

  await assert.rejects(
    f.store.authorizeInput({ ...admitted, connectionId: 'old-connection' }),
    admissionError('replaced'),
  );
  await database.document.send(new DeleteCommand({ TableName: f.table, Key: terminalInputKey(f.sessionId) }));
  await assert.rejects(f.store.authorizeInput(admitted), admissionError('replaced'));
});
