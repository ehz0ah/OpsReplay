import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  CreateTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTablesCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { WebSocket } from 'ws';

const dynamoImage = 'amazon/dynamodb-local@sha256:d89f8fcc6b1a39cb35976c248ed42a28c66ae00dc043099210f5571e42648ab4';
const gatewayImage = process.env.OPSREPLAY_GATEWAY_IMAGE ?? 'opsreplay/gateway-recording:dev';
const names = new Set();
const networks = new Set();

function docker(...args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
}

function removeContainer(name) {
  if (!names.has(name)) return;
  try {
    docker('rm', '--force', name);
  } catch {
    // Best-effort cleanup cannot change the completed test result.
  }
  names.delete(name);
}

function removeNetwork(name) {
  if (!networks.has(name)) return;
  docker('network', 'rm', name);
  networks.delete(name);
}

process.once('exit', () => {
  for (const name of names) {
    try {
      docker('rm', '--force', name);
    } catch {
      // Best-effort cleanup cannot change the completed test result.
    }
  }
  for (const network of networks) {
    try {
      docker('network', 'rm', network);
    } catch {
      // Best-effort cleanup cannot change the completed test result.
    }
  }
});

async function eventually(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(150);
  }
  assert.fail(message);
}

function health(address) {
  return new Promise((resolve, reject) => {
    const request = get(`http://${address}/healthz`, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
  });
}

function terminalError(address, sessionId, ticket) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${address}/v1/terminal`, { origin: 'https://app.opsreplay.test' });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Gateway terminal response timed out'));
    }, 10_000);
    const finish = (callback) => {
      clearTimeout(timer);
      socket.terminate();
      callback();
    };
    socket.once('open', () => socket.send(JSON.stringify({ type: 'auth', sessionId, ticket })));
    socket.once('message', (data, binary) => {
      finish(() => {
        try {
          assert.equal(binary, false);
          resolve(JSON.parse(data.toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.once('error', (error) => finish(() => reject(error)));
  });
}

test('the gateway runtime image includes the available Debian Perl security update', () => {
  const version = docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'sh',
    gatewayImage,
    '-c',
    "version=$(dpkg-query -W -f='${Version}' perl-base) && " +
      'dpkg --compare-versions "$version" ge "5.36.0-7+deb12u4" && printf "%s" "$version"',
  );
  assert.notEqual(version, '');
});

test('the gateway runtime image discovers work and stops cleanly', { timeout: 60_000 }, async () => {
  const suffix = randomUUID();
  const network = `opsreplay-gateway-runtime-${suffix}`;
  const database = `opsreplay-gateway-dynamodb-${suffix}`;
  const gateway = `opsreplay-gateway-runtime-${suffix}`;
  let client;
  try {
    const inspection = JSON.parse(docker('image', 'inspect', gatewayImage))[0];
    assert.equal(inspection.Config.User, 'node');
    assert.deepEqual(inspection.Config.Entrypoint, ['node', '/app/runtime.cjs']);

    docker('network', 'create', network);
    networks.add(network);
    docker(
      'run',
      '--detach',
      '--name',
      database,
      '--network',
      network,
      '--network-alias',
      'dynamodb',
      '--publish',
      '127.0.0.1::8000',
      '--label',
      'opsreplay.test=gateway-runtime',
      '--memory',
      '512m',
      '--cpus',
      '1',
      dynamoImage,
      '-jar',
      'DynamoDBLocal.jar',
      '-inMemory',
      '-sharedDb',
      '-disableTelemetry',
    );
    names.add(database);
    const address = docker('port', database, '8000/tcp');
    assert.match(address, /^127\.0\.0\.1:[0-9]+$/);
    client = new DynamoDBClient({
      endpoint: `http://${address}`,
      region: 'us-east-1',
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 500,
        requestTimeout: 1_000,
        throwOnRequestTimeout: true,
      }),
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    await eventually(async () => {
      try {
        await client.send(new ListTablesCommand({}));
        return true;
      } catch {
        return false;
      }
    }, 'DynamoDB Local did not become ready');
    await client.send(
      new CreateTableCommand({
        TableName: 'opsreplay-sessions',
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'WorkPK', AttributeType: 'S' },
          { AttributeName: 'WorkSK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'unfinished-work',
            KeySchema: [
              { AttributeName: 'WorkPK', KeyType: 'HASH' },
              { AttributeName: 'WorkSK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
          },
        ],
      }),
    );
    await client.send(
      new PutItemCommand({
        TableName: 'opsreplay-sessions',
        Item: {
          PK: { S: 'INVALID' },
          SK: { S: 'STATE' },
          WorkPK: { S: 'RECORDING' },
          WorkSK: { S: 'invalid' },
        },
      }),
    );

    const sessionId = randomUUID();
    const ticket = 't'.repeat(43);
    const ticketHash = createHash('sha256').update(ticket, 'utf8').digest('hex');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await client.send(
      new PutItemCommand({
        TableName: 'opsreplay-sessions',
        Item: {
          PK: { S: `SESSION#${sessionId}` },
          SK: { S: 'STATE' },
          data: {
            M: {
              ownerId: { S: 'runtime-test-user' },
              taskAddress: { S: '127.0.0.1' },
              view: { M: { id: { S: sessionId }, status: { S: 'ready' } } },
            },
          },
        },
      }),
    );
    await client.send(
      new PutItemCommand({
        TableName: 'opsreplay-sessions',
        Item: {
          PK: { S: `SESSION#${sessionId}` },
          SK: { S: `TICKET#${ticketHash}` },
          data: {
            M: {
              schemaVersion: { N: '1' },
              sessionId: { S: sessionId },
              ownerId: { S: 'runtime-test-user' },
              expiresAt: { S: expiresAt },
            },
          },
          ExpiresAt: { N: String(Math.floor(Date.parse(expiresAt) / 1000)) },
        },
      }),
    );

    docker(
      'run',
      '--detach',
      '--name',
      gateway,
      '--network',
      network,
      '--publish',
      '127.0.0.1::8080',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges=true',
      '--cpus',
      '0.5',
      '--memory',
      '256m',
      '--memory-swap',
      '256m',
      '--pids-limit',
      '64',
      '--env',
      'AWS_ACCESS_KEY_ID=local',
      '--env',
      'AWS_SECRET_ACCESS_KEY=local',
      '--env',
      'AWS_REGION=us-east-1',
      '--env',
      'AWS_EC2_METADATA_DISABLED=true',
      '--env',
      'AWS_ENDPOINT_URL_DYNAMODB=http://dynamodb:8000',
      '--env',
      'SESSION_TABLE_NAME=opsreplay-sessions',
      '--env',
      'RECORDING_BUCKET_NAME=opsreplay-recordings',
      '--env',
      'MAXIMUM_CONCURRENT_RECORDINGS=2',
      '--env',
      'MONITOR_PORT=9443',
      '--env',
      'GATEWAY_PORT=8080',
      '--env',
      'TERMINAL_ALLOWED_ORIGINS=https://app.opsreplay.test',
      '--env',
      'MAXIMUM_TERMINAL_CONNECTIONS=16',
      '--env',
      'MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS=4',
      '--env',
      'TERMINAL_PORT=7681',
      '--label',
      'opsreplay.test=gateway-runtime',
      gatewayImage,
    );
    names.add(gateway);
    await eventually(() => {
      const logs = docker('logs', gateway);
      return logs.includes('"type":"service_started"') && logs.includes('"type":"source_invalid"');
    }, 'Gateway did not discover the malformed work item through DynamoDB Local');

    const gatewayAddress = docker('port', gateway, '8080/tcp');
    assert.match(gatewayAddress, /^127\.0\.0\.1:[0-9]+$/);
    assert.deepEqual(await health(gatewayAddress), { status: 200, body: '{"status":"ready"}\n' });
    assert.deepEqual(await terminalError(gatewayAddress, sessionId, ticket), {
      type: 'error',
      code: 'INTERNAL_ERROR',
      message: 'The terminal connection failed.',
    });
    assert.equal(
      (
        await client.send(
          new GetItemCommand({
            TableName: 'opsreplay-sessions',
            Key: { PK: { S: `SESSION#${sessionId}` }, SK: { S: `TICKET#${ticketHash}` } },
            ConsistentRead: true,
          }),
        )
      ).Item,
      undefined,
    );
    assert.ok(
      (
        await client.send(
          new GetItemCommand({
            TableName: 'opsreplay-sessions',
            Key: { PK: { S: `SESSION#${sessionId}` }, SK: { S: 'INPUT' } },
            ConsistentRead: true,
          }),
        )
      ).Item,
    );

    docker('stop', '--time', '10', gateway);
    const logs = docker('logs', gateway);
    assert.match(logs, /"type":"shutdown_requested","signal":"SIGTERM"/);
    assert.match(logs, /"type":"service_stopped"/);
    assert.doesNotMatch(logs, /"type":"service_failed"/);
    assert.doesNotMatch(logs, new RegExp(`${ticket}|opsreplay-recordings|AWS_SECRET_ACCESS_KEY`));
  } finally {
    client?.destroy();
    removeContainer(gateway);
    removeContainer(database);
    removeNetwork(network);
  }
});

test('the gateway runtime image fails closed without configuration', () => {
  assert.throws(
    () => docker('run', '--rm', '--network', 'none', '--read-only', gatewayImage),
    (error) => {
      const output = String(error.stderr ?? '') + String(error.stdout ?? '');
      assert.equal(error.status, 1);
      assert.match(output, /"type":"service_failed"/);
      assert.match(output, /"name":"Error"/);
      assert.doesNotMatch(output, /SESSION_TABLE_NAME/);
      return true;
    },
  );
});
