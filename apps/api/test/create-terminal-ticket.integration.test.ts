import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import {
  terminalSessionKey,
  terminalTicketHash,
  terminalTicketKey,
  terminalTicketTtlAttribute,
} from '../../../packages/contracts/private/terminal-access.js';
import { loadTerminalTicketConfiguration } from '../src/create-terminal-ticket/configuration.js';
import { createTerminalTicketHandler } from '../src/create-terminal-ticket/handler.js';
import { DynamoTerminalTicketStore, type TerminalTicketIssuer } from '../src/create-terminal-ticket/store.js';
import { createMonitorCertificate } from '../src/session-lifecycle/monitor-certificate.js';
import type { SessionRecord, SessionView } from '../src/start-session/types.js';
import { validSession, validSessionRelations, validTerminalTicket } from '../src/start-session/validation.js';
import { startLocalDatabase } from './local-dynamodb.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

const now = '2026-10-10T08:00:00.000Z';
const expiresAt = '2026-10-10T08:01:00.000Z';
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherOwnerId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const gatewayUrl = 'wss://terminal.opsreplay.example/v1/terminal';
const ticketA = 'A'.repeat(43);
const ticketB = 'B'.repeat(43);
const taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/opsreplay-test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const context = { awsRequestId: requestId, getRemainingTimeInMillis: () => 10_000 };

function sessionRecord(id: string): SessionRecord {
  return {
    ownerId,
    view: {
      id,
      challenge: {
        id: 'wrong-upstream-port',
        version: '0.1.0',
        title: 'Storefront returns 502',
        tier: 'easy',
        category: 'networking',
      },
      attempt: { kind: 'first', number: 1 },
      status: 'provisioning',
      statusReason: null,
      alert: { title: 'Checkout errors', summary: 'Checkout requests fail.', severity: 'critical' },
      dashboard: [{ id: 'error_rate', label: 'Errors', unit: 'percent' }],
      recovery: null,
      timeLimitSeconds: 1200,
      createdAt: '2026-10-10T07:58:00.000Z',
      readyAt: null,
      endsAt: null,
      endedAt: null,
      hints: { released: [], remaining: 2, nextAvailableAt: null },
      assistance: { hintsReleased: 0, assistantTurns: 0, proposalsRun: 0 },
      debriefAvailable: false,
      recording: { status: 'pending', reason: null },
    },
    accessGrant: { plan: 'free', admittedAt: '2026-10-10T07:58:00.000Z', timeLimitSeconds: 1200 },
    pins: {
      taskDefinitionArn: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      challengeImageDigest: `sha256:${'a'.repeat(64)}`,
      monitorImageDigest: `sha256:${'b'.repeat(64)}`,
    },
    launchArguments: {
      cluster: 'arn:aws:ecs:ap-southeast-1:123456789012:cluster/opsreplay-test',
      taskDefinition: 'arn:aws:ecs:ap-southeast-1:123456789012:task-definition/opsreplay-test:1',
      clientToken: id,
      startedBy: id,
      count: 1,
      enableExecuteCommand: false,
      launchType: 'FARGATE',
      platformVersion: '1.4.0',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ['subnet-0123456789abcdef0'],
          securityGroups: ['sg-0123456789abcdef0'],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'monitor',
            environment: [{ name: 'OPSREPLAY_SESSION_ID', value: id }],
            environmentFiles: [{ type: 's3', value: `arn:aws:s3:::test-secrets/sessions/${id}.env` }],
          },
        ],
      },
      tags: [{ key: 'opsreplay:session-id', value: id }],
    },
    monitorSecret: 's'.repeat(43),
    monitorCertificate: null,
    launchFailure: null,
    provisioningDeadline: '2026-10-10T08:01:00.000Z',
    launchRecoveryDeadline: '2026-10-10T08:06:00.000Z',
    scheduleName: `session-${id}`,
    taskArn: null,
    taskAddress: null,
    provisioningCleanup: { status: 'pending', completedAt: null },
  };
}

const certificate = (await createMonitorCertificate(sessionRecord('44444444-4444-4444-8444-444444444444'))).certificate;

function withStatus(id: string, status: SessionView['status']): SessionRecord {
  const session = sessionRecord(id);
  if (status !== 'provisioning') {
    session.monitorCertificate = certificate;
    session.taskArn = taskArn;
    session.taskAddress = '10.0.1.42';
    session.view.readyAt = '2026-10-10T07:59:00.000Z';
    session.view.endsAt = '2026-10-10T08:19:00.000Z';
    session.view.recording.status = status === 'ready' ? 'recording' : 'draining';
  }
  session.view.status = status;
  if (status !== 'provisioning' && status !== 'ready') {
    session.view.statusReason = status === 'resolved' ? 'validators_passed' : 'environment_exited';
    session.view.endedAt = now;
  }
  assert.ok(validSession(session), JSON.stringify(validSession.errors));
  assert.equal(validSessionRelations(session), true);
  return session;
}

function event(sessionId: string, actor: unknown = ownerId): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    resource: '/v1/sessions/{id}/terminal-tickets',
    path: `/v1/sessions/${sessionId}/terminal-tickets`,
    headers: {},
    multiValueHeaders: {},
    pathParameters: { id: sessionId },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    isBase64Encoded: false,
    body: null,
    requestContext: { authorizer: { claims: { sub: actor } } },
  } as unknown as APIGatewayProxyEvent;
}

async function fixture(status: SessionView['status'] = 'ready') {
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
  const putSession = async (value: SessionRecord) =>
    database.document.send(
      new PutCommand({ TableName: table, Item: { ...terminalSessionKey(sessionId), data: value } }),
    );
  await putSession(withStatus(sessionId, status));
  const logs: unknown[] = [];
  const makeHandler = (client: DynamoDBDocumentClient = database.document, newTicket: () => string = () => ticketA) =>
    createTerminalTicketHandler({
      store: new DynamoTerminalTicketStore(client, table),
      gatewayUrl,
      now: () => new Date(now),
      newTicket,
      log: (entry) => logs.push(entry),
    });
  const item = async (ticket: string) =>
    (
      await database.document.send(
        new GetCommand({
          TableName: table,
          Key: terminalTicketKey(sessionId, terminalTicketHash(ticket)),
          ConsistentRead: true,
        }),
      )
    ).Item;
  return { table, sessionId, logs, putSession, makeHandler, item, handler: makeHandler() };
}

const bodyOf = (value: { body: string }) => JSON.parse(value.body);

test('issues one opaque ticket and stores only its hash with expiry', async () => {
  const f = await fixture();
  const result = await f.handler(event(f.sessionId), context);

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers?.['Cache-Control'], 'no-store');
  assert.deepEqual(bodyOf(result), { sessionId: f.sessionId, ticket: ticketA, url: gatewayUrl, expiresAt });
  assert.ok(validTerminalTicket(bodyOf(result)));
  assert.deepEqual(await f.item(ticketA), {
    ...terminalTicketKey(f.sessionId, terminalTicketHash(ticketA)),
    data: { schemaVersion: 1, sessionId: f.sessionId, ownerId, expiresAt },
    [terminalTicketTtlAttribute]: Date.parse(expiresAt) / 1000,
  });
  const rows = await database.document.send(new ScanCommand({ TableName: f.table, ConsistentRead: true }));
  assert.equal(JSON.stringify(rows.Items).includes(ticketA), false);
  assert.deepEqual(Object.keys(f.logs[0] as object).sort(), [
    'durationMs',
    'operation',
    'requestId',
    'result',
    'sessionId',
  ]);
  assert.equal(JSON.stringify(f.logs).includes(ticketA), false);
});

test('the default generator creates a 256-bit base64url ticket', async () => {
  let storedHash: string | undefined;
  const store: TerminalTicketIssuer = {
    issue: async ({ ticketHash }) => {
      storedHash = ticketHash;
      return 'issued';
    },
  };
  const handler = createTerminalTicketHandler({ store, gatewayUrl, now: () => new Date(now) });

  const result = await handler(event(randomUUID()), context);
  const ticket: unknown = bodyOf(result).ticket;
  assert.equal(result.statusCode, 200);
  assert.equal(typeof ticket, 'string');
  assert.equal(Buffer.from(ticket as string, 'base64url').byteLength, 32);
  assert.equal(storedHash, terminalTicketHash(ticket as string));
});

test('hides other learners and rejects non-ready session states without a ticket', async () => {
  const owned = await fixture();
  assert.equal((await owned.handler(event(owned.sessionId, otherOwnerId), context)).statusCode, 404);
  assert.equal(await owned.item(ticketA), undefined);

  const provisioning = await fixture('provisioning');
  const notReady = await provisioning.handler(event(provisioning.sessionId), context);
  assert.equal(notReady.statusCode, 409);
  assert.equal(bodyOf(notReady).code, 'SESSION_NOT_READY');
  assert.equal(await provisioning.item(ticketA), undefined);

  for (const status of ['resolved', 'failed', 'ended', 'abandoned', 'error'] as const) {
    const terminal = await fixture(status);
    const ended = await terminal.handler(event(terminal.sessionId), context);
    assert.equal(ended.statusCode, 409);
    assert.equal(bodyOf(ended).code, 'SESSION_TERMINAL');
    assert.equal(await terminal.item(ticketA), undefined);
  }
});

test('the transaction rejects a session outcome that races ticket issuance', async () => {
  const f = await fixture();
  let writes = 0;
  const client = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) {
        writes++;
        await f.putSession(withStatus(f.sessionId, 'resolved'));
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;

  const result = await f.makeHandler(client)(event(f.sessionId), context);
  assert.equal(result.statusCode, 409);
  assert.equal(bodyOf(result).code, 'SESSION_TERMINAL');
  assert.equal(await f.item(ticketA), undefined);
  assert.equal(writes, 1);
});

test('recovers a committed ticket after the transaction response is lost', async () => {
  const f = await fixture();
  let writes = 0;
  const client = {
    send: async (command: unknown, options: unknown) => {
      const result = await database.document.send(command as never, options as never);
      if (command instanceof TransactWriteCommand && writes++ === 0) {
        throw Object.assign(new Error('response lost'), { name: 'TimeoutError' });
      }
      return result;
    },
  } as unknown as DynamoDBDocumentClient;

  const result = await f.makeHandler(client)(event(f.sessionId), context);
  assert.equal(result.statusCode, 200);
  assert.equal(bodyOf(result).ticket, ticketA);
  assert.ok(await f.item(ticketA));
  assert.equal(writes, 1);
});

test('retries known transaction contention with a fixed bound', async () => {
  const recovered = await fixture();
  let recoveredWrites = 0;
  const recoveredClient = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand && recoveredWrites++ === 0) {
        throw Object.assign(new Error('transaction conflict'), { name: 'TransactionConflictException' });
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;

  const success = await recovered.makeHandler(recoveredClient)(event(recovered.sessionId), context);
  assert.equal(success.statusCode, 200);
  assert.equal(recoveredWrites, 2);

  const exhausted = await fixture();
  let exhaustedWrites = 0;
  const exhaustedClient = {
    send: async (command: unknown, options: unknown) => {
      if (command instanceof TransactWriteCommand) {
        exhaustedWrites++;
        throw Object.assign(new Error('transaction conflict'), { name: 'TransactionConflictException' });
      }
      return database.document.send(command as never, options as never);
    },
  } as unknown as DynamoDBDocumentClient;

  const failure = await exhausted.makeHandler(exhaustedClient)(event(exhausted.sessionId), context);
  assert.equal(failure.statusCode, 500);
  assert.equal(exhaustedWrites, 3);
  assert.equal(await exhausted.item(ticketA), undefined);
});

test('uses a new random value after a ticket hash collision', async () => {
  const f = await fixture();
  await database.document.send(
    new PutCommand({
      TableName: f.table,
      Item: {
        ...terminalTicketKey(f.sessionId, terminalTicketHash(ticketA)),
        data: { schemaVersion: 1, sessionId: f.sessionId, ownerId, expiresAt: '2026-10-10T08:00:30.000Z' },
        [terminalTicketTtlAttribute]: Date.parse('2026-10-10T08:00:30.000Z') / 1000,
      },
    }),
  );
  const tickets = [ticketA, ticketB];
  const result = await f.makeHandler(database.document, () => tickets.shift()!)(event(f.sessionId), context);

  assert.equal(result.statusCode, 200);
  assert.equal(bodyOf(result).ticket, ticketB);
  assert.equal((await f.item(ticketA))?.data.expiresAt, '2026-10-10T08:00:30.000Z');
  assert.ok(await f.item(ticketB));
});

test('does not retry definite DynamoDB configuration failures', async () => {
  const f = await fixture();
  for (const name of ['AccessDeniedException', 'ValidationException']) {
    let writes = 0;
    const client = {
      send: async (command: unknown, options: unknown) => {
        if (command instanceof TransactWriteCommand) {
          writes++;
          throw Object.assign(new Error('write rejected'), { name });
        }
        return database.document.send(command as never, options as never);
      },
    } as unknown as DynamoDBDocumentClient;

    const result = await f.makeHandler(client)(event(f.sessionId), context);
    assert.equal(result.statusCode, 500);
    assert.equal(bodyOf(result).code, 'INTERNAL_ERROR');
    assert.equal(writes, 1);
  }
  assert.equal(await f.item(ticketA), undefined);
});

test('rejects invalid identity and request shape before storage access', async () => {
  let calls = 0;
  const store: TerminalTicketIssuer = {
    issue: async () => {
      calls++;
      return 'issued';
    },
  };
  const handler = createTerminalTicketHandler({ store, gatewayUrl, newTicket: () => ticketA });
  const sessionId = randomUUID();

  for (const actor of [null, '', 'a#b', { sub: ownerId }, 'x'.repeat(129)]) {
    assert.equal((await handler(event(sessionId, actor), context)).statusCode, 401);
  }
  const invalidEvents = [
    { ...event(sessionId), httpMethod: 'GET' },
    { ...event(sessionId), resource: '/v1/sessions/{id}' },
    { ...event(sessionId), pathParameters: { id: 'not-a-session' } },
    { ...event(sessionId), body: '{}' },
  ];
  for (const invalid of invalidEvents) {
    assert.equal((await handler(invalid, context)).statusCode, 400);
  }
  assert.equal(calls, 0);
});

test('configuration, generation, deadlines, and storage failures fail closed', async () => {
  assert.throws(() => loadTerminalTicketConfiguration({}), /TERMINAL_GATEWAY_URL is invalid/);
  for (const value of [
    'http://terminal.opsreplay.example/v1/terminal',
    'wss://user@terminal.opsreplay.example/v1/terminal',
    'wss://terminal.opsreplay.example/v1/other',
    'wss://terminal.opsreplay.example/v1/terminal?ticket=secret',
  ]) {
    assert.throws(() => loadTerminalTicketConfiguration({ TERMINAL_GATEWAY_URL: value }), /invalid/);
  }
  assert.deepEqual(loadTerminalTicketConfiguration({ TERMINAL_GATEWAY_URL: gatewayUrl }), { gatewayUrl });
  assert.throws(
    () => new DynamoTerminalTicketStore({} as DynamoDBDocumentClient, 'x'),
    /Invalid terminal ticket table/,
  );

  let calls = 0;
  const unavailable: TerminalTicketIssuer = {
    issue: async () => {
      calls++;
      throw new Error('private storage failure');
    },
  };
  const logs: unknown[] = [];
  const handler = createTerminalTicketHandler({
    store: unavailable,
    gatewayUrl,
    newTicket: () => ticketA,
    now: () => new Date(now),
    log: (entry) => logs.push(entry),
  });
  const failure = await handler(event(randomUUID()), context);
  assert.equal(failure.statusCode, 500);
  assert.equal(bodyOf(failure).code, 'INTERNAL_ERROR');
  assert.equal(failure.body.includes('private storage failure'), false);
  assert.equal(JSON.stringify(logs).includes(ticketA), false);
  assert.equal(calls, 1);

  const invalidTicket = createTerminalTicketHandler({
    store: unavailable,
    gatewayUrl,
    newTicket: () => 'short',
    now: () => new Date(now),
  });
  assert.equal((await invalidTicket(event(randomUUID()), context)).statusCode, 500);
  assert.equal(calls, 1);

  const expired = createTerminalTicketHandler({
    store: unavailable,
    gatewayUrl,
    newTicket: () => ticketA,
    now: () => new Date(now),
  });
  assert.equal(
    (await expired(event(randomUUID()), { ...context, getRemainingTimeInMillis: () => 1000 })).statusCode,
    500,
  );
  assert.equal(calls, 1);
});

test('the bundled Lambda validates identity before AWS access', async () => {
  const previousTable = process.env.SESSION_TABLE_NAME;
  const previousGateway = process.env.TERMINAL_GATEWAY_URL;
  try {
    process.env.SESSION_TABLE_NAME = 'test-unused';
    process.env.TERMINAL_GATEWAY_URL = gatewayUrl;
    const bundled = createRequire(import.meta.url)('../../../dist/create-terminal-ticket/index.cjs');
    const result = await bundled.handler(event(randomUUID(), null), context);
    assert.equal(result.statusCode, 401);
  } finally {
    if (previousTable === undefined) delete process.env.SESSION_TABLE_NAME;
    else process.env.SESSION_TABLE_NAME = previousTable;
    if (previousGateway === undefined) delete process.env.TERMINAL_GATEWAY_URL;
    else process.env.TERMINAL_GATEWAY_URL = previousGateway;
  }
});
