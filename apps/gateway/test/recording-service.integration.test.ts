import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RecordedEvidenceReader } from '../../../packages/session/src/recorded-evidence.js';
import { readManifest, manifestHash, manifestKey } from '../../../packages/session/src/manifest.js';
import { createFinaliseSession } from '../../../packages/session/src/finalise.js';
import { DynamoFinaliseStore } from '../../../packages/session/src/finalise-store.js';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { generate } from 'selfsigned';
import { recordingWorkOrder, unfinishedWorkIndex } from '../../../packages/contracts/private/recording-work.js';
import {
  terminalOutput,
  terminalPage,
  terminalReady,
} from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { startLocalDatabase } from '../../api/test/local-dynamodb.js';
import { Monitor } from '../../monitor/src/monitor.js';
import { MonitorControl } from '../../monitor/src/control.js';
import { FileCaptures } from '../../monitor/src/captures.js';
import { createControlServer } from '../../monitor/src/server.js';
import type { MonitorConfig } from '../../monitor/src/types.js';
import { createGatewayRecordingSupervisor } from '../src/recording-service.js';
import { DynamoMonitorRecordingStore } from '../src/monitor-recording-store.js';
import { DynamoTerminalRecordingStore } from '../src/terminal-recording-store.js';
import { DynamoTerminalSealingStore } from '../src/terminal-sealing-store.js';
import { DynamoAttemptStore } from '../../../packages/session/src/attempt-store.js';
import { sessionRecord } from '../../api/test/session-fixture.js';
import { initialSessionLifecycle, lifecycleWorkItem } from '../../../packages/contracts/private/session-lifecycle.js';

let database: Awaited<ReturnType<typeof startLocalDatabase>>;
before(
  async () => {
    database = await startLocalDatabase();
  },
  { timeout: 60_000 },
);
after(() => database?.close());

async function eventually(check: () => Promise<boolean>, message: string) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(message);
}

test(
  'production composition collects both network sources, seals durable pages, and retires combined work',
  { timeout: 30_000 },
  async (t) => {
    const sessionId = randomUUID();
    const table = `test-${randomUUID()}`;
    const startedAt = new Date(Date.now() - 2_000).toISOString();
    const source = randomUUID();
    const tls = await generate([{ name: 'commonName', value: 'opsreplay-monitor' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date(Date.now() - 60_000),
      notAfterDate: new Date(Date.now() + 60_000),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
      ],
    });
    const config: MonitorConfig = {
      journeys: [
        {
          id: 'checkout',
          ratePerSecond: 1,
          steps: [{ method: 'GET', url: 'http://127.0.0.1/', expectStatus: [200], timeoutMs: 100 }],
        },
      ],
      validators: [{ id: 'recovery', check: { kind: 'journey', journey: 'checkout' }, sustainSeconds: 60 }],
      probes: [],
    };
    const monitor = new Monitor(config, { http: async () => ({ status: 502, body: '' }), tcp: async () => true });
    const control = new MonitorControl(
      monitor,
      undefined,
      new FileCaptures(
        { configs: [], logs: [] },
        undefined,
        () => new Date(monitor.now()).toISOString(),
        () => monitor.snapshot().sample,
      ),
    );
    await control.initialise();
    const secret = 's'.repeat(43);
    const https = createControlServer(control, { key: tls.private, cert: tls.cert, secret });
    https.listen(0, '127.0.0.1');
    await once(https, 'listening');
    const monitorAddress = https.address();
    assert.ok(monitorAddress && typeof monitorAddress === 'object');
    const sockets = new Set<Socket>();
    const terminal = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as { type: string; after: number };
          buffer = buffer.slice(newline + 1);
          const metadata = {
            source,
            startedAt,
            observedAt: new Date(Date.now() + 2_000).toISOString(),
            latestSequence: 2,
          };
          if (request.type === 'attach') {
            socket.write(JSON.stringify(terminalReady(metadata)) + '\n');
          } else {
            assert.equal(request.type, 'read');
            const events = [
              { type: 'dimensions' as const, sequence: 1, recordedAt: startedAt, columns: 80, rows: 24 },
              terminalOutput(2, startedAt),
            ].filter((event) => event.sequence > request.after);
            socket.write(JSON.stringify(terminalPage(events, { ...metadata, nextSequence: 2 })) + '\n');
          }
        }
      });
    });
    terminal.listen(0, '127.0.0.1');
    await once(terminal, 'listening');
    const terminalAddress = terminal.address();
    assert.ok(terminalAddress && typeof terminalAddress === 'object');
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    const cancel = () => controller.abort();
    t.signal.addEventListener('abort', cancel, { once: true });
    t.after(async () => {
      controller.abort();
      try {
        await running;
      } finally {
        t.signal.removeEventListener('abort', cancel);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => terminal.close(() => resolve()));
        https.closeAllConnections();
        await new Promise<void>((resolve) => https.close(() => resolve()));
        await control.close();
      }
    });
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
          { AttributeName: 'WorkPK', AttributeType: 'S' },
          { AttributeName: 'WorkSK', AttributeType: 'S' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: unfinishedWorkIndex.name,
            KeySchema: [
              { AttributeName: 'WorkPK', KeyType: 'HASH' },
              { AttributeName: 'WorkSK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'KEYS_ONLY' },
          },
        ],
      }),
    );
    const key = { PK: `SESSION#${sessionId}`, SK: 'STATE' };
    const savedSession = sessionRecord(sessionId);
    savedSession.view.createdAt = startedAt;
    savedSession.accessGrant.admittedAt = startedAt;
    savedSession.provisioningDeadline = new Date(Date.now() + 60_000).toISOString();
    savedSession.monitorSecret = secret;
    savedSession.monitorCertificate = tls.cert;
    savedSession.taskAddress = '127.0.0.1';
    savedSession.taskArn = 'arn:aws:ecs:ap-southeast-1:123456789012:task/test/1234';
    const item = { ...key, WorkPK: 'RECORDING', WorkSK: recordingWorkOrder(startedAt, sessionId), data: savedSession };
    await database.document.send(new PutCommand({ TableName: table, Item: item }));
    await database.document.send(
      new PutCommand({ TableName: table, Item: lifecycleWorkItem(initialSessionLifecycle(sessionId, startedAt)) }),
    );
    const objects = new Map<string, { bytes: Buffer; tag: string }>();
    const s3 = {
      send: async (command: GetObjectCommand | PutObjectCommand) => {
        const objectKey = command.input.Key!;
        if (command instanceof PutObjectCommand) {
          assert.equal(command.input.IfNoneMatch, '*');
          const bytes = Buffer.from(command.input.Body as Uint8Array);
          const saved = objects.get(objectKey);
          if (saved) {
            assert.deepEqual(bytes, saved.bytes);
            throw new S3ServiceException({
              name: 'PreconditionFailed',
              $fault: 'client',
              $metadata: { httpStatusCode: 412 },
            });
          }
          objects.set(objectKey, { bytes, tag: command.input.Tagging! });
          return {};
        }
        const saved = objects.get(objectKey);
        assert.ok(saved, 'Only committed object references can be read');
        return { ContentLength: saved.bytes.length, Body: Readable.from([saved.bytes]) };
      },
    } as unknown as S3Client;
    const reports: string[] = [];
    const failures: unknown[] = [];
    const supervisor = createGatewayRecordingSupervisor(
      {
        sessionTableName: table,
        recordingBucketName: 'opsreplay-recordings-test',
        recorderId: 'gateway-composed',
        maximumConcurrentRecordings: 1,
        monitorPort: monitorAddress.port,
        terminalPort: terminalAddress.port,
        pollIntervalMs: 100,
        renewalIntervalMs: 100,
        monitorPollIntervalMs: 100,
        report: (event) => {
          reports.push(event.type);
          if (event.type === 'runner_failed') failures.push(event.error);
        },
      },
      { dynamo: database.document, s3 },
    );
    running = supervisor.run(controller.signal);
    // Observe rejection immediately. Cleanup still awaits and reports the failure,
    // but an early rejection must not bypass socket cleanup or leak the Monitor timer.
    void running.catch(() => controller.abort());
    const recordings = new DynamoMonitorRecordingStore(database.document, table);
    const terminals = new DynamoTerminalRecordingStore(database.document, table);
    await eventually(
      async () =>
        ((await recordings.get(sessionId))?.cursor ?? 0) > 0 && (await terminals.get(sessionId))?.cursor === 2,
      'Both durable collectors must advance',
    );
    const attempts = new DynamoAttemptStore(database.document, table);
    await eventually(
      async () => (await attempts.session(sessionId))?.view.status === 'ready',
      'Ready requires both committed collectors',
    );
    const ready = await attempts.session(sessionId);
    assert.equal(ready?.view.readyAt, (await recordings.get(sessionId))?.startedAt);
    assert.equal(ready?.view.recovery?.requiredSeconds, 60);
    const cutoffAt = new Date().toISOString();
    await attempts.outcome(
      sessionId,
      'ended',
      'learner_ended',
      cutoffAt,
      undefined,
      savedSession.ownerId,
      undefined,
      cutoffAt,
      randomUUID(),
    );
    await eventually(
      async () => (await recordings.get(sessionId))?.status === 'complete',
      'Combined recording did not complete',
    );
    const sealed = await new DynamoTerminalSealingStore(database.document, table).get(sessionId);
    assert.equal(sealed?.complete, true);
    assert.equal(sealed?.cursor, 2);
    assert.equal(sealed?.cutoffAt, cutoffAt);
    assert.ok(
      [...objects].some(
        ([key, value]) =>
          key.includes('/terminal/') && key.includes('/sealed/') && value.tag === 'opsreplay-retention=sealed',
      ),
    );
    assert.ok(
      [...objects].some(([key, value]) => key.includes('/metrics/') && value.tag === 'opsreplay-retention=sealed'),
    );
    await eventually(
      async () =>
        !(await database.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item
          ?.WorkPK,
      'Completed combined work was not retired',
    );
    assert.deepEqual(failures, []);
    assert.ok(await recordings.coverage(sessionId));
    const content = JSON.parse(
      readFileSync(new URL('../../../content/challenges/wrong-upstream-port/challenge.json', import.meta.url), 'utf8'),
    ) as unknown;
    const finalSession = (
      await database.document.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))
    ).Item!.data as typeof savedSession;
    finalSession.pins.manifestSha256 = manifestHash(content);
    await database.document.send(new PutCommand({ TableName: table, Item: { ...key, data: finalSession } }));
    await database.document.send(
      new PutCommand({
        TableName: table,
        Item: {
          ...manifestKey(
            finalSession.view.challenge.id,
            finalSession.view.challenge.version,
            finalSession.pins.manifestSha256,
          ),
          data: content,
        },
      }),
    );
    const evidenceReader = new RecordedEvidenceReader(database.document, table, s3, 'opsreplay-recordings-test');
    const evidence = await evidenceReader.read(finalSession);
    assert.equal(evidence.commands.length, 0);
    assert.ok(evidence.counters);
    await attempts.cleanup(sessionId, new Date().toISOString(), true);
    const store = new DynamoFinaliseStore(database.document, table);
    const finalise = createFinaliseSession({
      store,
      manifest: (session, signal) => readManifest(database.document, table, session, signal),
      evidence: (session, signal) => evidenceReader.read(session, signal),
    });
    await finalise(finalSession);
    const debrief = await store.saved(sessionId);
    assert.equal(debrief?.outcome, 'ended');
    assert.equal(debrief?.score?.commandCount, 0);
    assert.equal(debrief?.score?.failedRequests, evidence.counters?.failedRequests);
    assert.deepEqual(
      debrief?.keyEvidence.map((v) => v.status),
      ['not_observed', 'not_observed', 'not_observed'],
    );
    await finalise(finalSession);
  },
);
