import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const image = 'amazon/dynamodb-local@sha256:d89f8fcc6b1a39cb35976c248ed42a28c66ae00dc043099210f5571e42648ab4';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();

export async function startLocalDatabase() {
  const name = `opsreplay-admission-${randomUUID()}`;
  let client: DynamoDBClient | undefined;
  let created = false;
  const close = () => {
    client?.destroy();
    if (created) docker('rm', '--force', name);
    created = false;
  };
  try {
    docker(
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--publish',
      '127.0.0.1::8000',
      '--label',
      'opsreplay.test=session-start',
      image,
      '-jar',
      'DynamoDBLocal.jar',
      '-inMemory',
      '-sharedDb',
      '-disableTelemetry',
    );
    created = true;
    const address = docker('port', name, '8000/tcp');
    if (!/^127\.0\.0\.1:[0-9]+$/.test(address)) throw new Error('DynamoDB Local must bind to loopback');
    client = new DynamoDBClient({
      endpoint: `http://${address}`,
      region: 'us-east-1',
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 500,
        requestTimeout: 1000,
        throwOnRequestTimeout: true,
      }),
      // Explicit dummy credentials prevent all use of personal or work AWS profiles.
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await client.send(new ListTablesCommand({}));
        return { client, document: DynamoDBDocumentClient.from(client), close };
      } catch (error) {
        if (attempt === 99) throw error;
        await setTimeout(200);
      }
    }
    throw new Error('DynamoDB Local did not become ready');
  } catch (error) {
    close();
    throw error;
  }
}
