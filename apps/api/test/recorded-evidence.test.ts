import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import { RecordedEvidenceReader } from '../../../packages/session/src/recorded-evidence.js';
import {
  commandId,
  initialCommandParser,
  type CommandEvidence,
} from '../../../packages/contracts/private/command-evidence.js';
import { recordingRetainUntil } from '../../../packages/contracts/private/recording-retention.js';
import { readRecordingObject } from '../../../packages/session/src/object-reader.js';
import { sessionRecord } from './session-fixture.js';
import {
  initialTerminalCheckpoint,
  advanceTerminalCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import { terminalReady, terminalPage } from '../../../packages/contracts/private/test-support/terminal-fixture.js';

const at = '2026-10-12T00:00:00.000Z';
const end = '2026-10-12T00:00:05.000Z';
function fixture() {
  const id = randomUUID();
  const source = randomUUID();
  const session = sessionRecord(id);
  Object.assign(session.view, {
    status: 'ended',
    readyAt: at,
    endedAt: end,
    recording: { status: 'incomplete', reason: 'data_gap' },
  });
  const command: CommandEvidence = {
    id: commandId(source, 1),
    seq: 1,
    at,
    endedAt: end,
    kind: 'command',
    command: 'cat /etc/config',
    exitStatus: 0,
    source: 'learner',
    changedFiles: [],
    outputExcerpt: 'saved output',
    outputTruncated: false,
    metrics: null,
  };
  const parser = { ...initialCommandParser(source), count: 1, cursor: 1 };
  const recording = {
    schemaVersion: 1,
    status: 'incomplete',
    recorderId: null,
    generation: 1,
    leaseExpiresAt: null,
    startedAt: at,
    source,
    cursor: 1,
    cutoffAt: end,
    drainDeadlineAt: end,
    sealed: null,
    retainUntil: recordingRetainUntil(at, 'provisional'),
    reason: 'data_gap',
    updatedAt: end,
    completedAt: end,
  };
  const event = { id: `${source}:1`, at: end, kind: 'monitor', signal: 'outage_started', label: 'Proxy' };
  const records = new Map<string, unknown>([
    ['RECORDING', recording],
    ['COMMAND_PARSER', parser],
    ['COMMAND#000001', command],
    [
      'MONITOR_EVENTS#000001',
      { schemaVersion: 1, source, after: 0, nextSequence: 1, events: [{ sequence: 1, recordedAt: end, event }] },
    ],
  ]);
  let repeatedCursor = false;
  const dynamo = {
    send: async (request: GetCommand | QueryCommand) => {
      if (request instanceof GetCommand) {
        const data = records.get(request.input.Key!.SK as string);
        return data === undefined ? {} : { Item: { data } };
      }
      const prefix = request.input.ExpressionAttributeValues![':prefix'] as string;
      const Items = [...records].filter(([SK]) => SK.startsWith(prefix)).map(([SK, data]) => ({ SK, data }));
      return { Items, ...(repeatedCursor ? { LastEvaluatedKey: { PK: `SESSION#${id}`, SK: prefix } } : {}) };
    },
  } as unknown as DynamoDBDocumentClient;
  const s3 = {
    send: async () => {
      throw new Error('Partial reads must not fetch provisional S3 data.');
    },
  } as unknown as S3Client;
  return {
    session,
    command,
    parser,
    records,
    event,
    reader: new RecordedEvidenceReader(dynamo, 'test-sessions', s3, 'test-recordings'),
    repeat: () => {
      repeatedCursor = true;
    },
  };
}
test('partial evidence retains saved Monitor events and never invents final counters', async () => {
  const f = fixture();
  const evidence = await f.reader.read(f.session);
  assert.deepEqual(evidence.commands, [f.command]);
  assert.deepEqual(evidence.events, [f.event]);
  assert.equal(evidence.counters, null);
});
test('post-cutoff command output and Monitor observations cannot enter partial debrief evidence', async () => {
  const f = fixture();
  f.records.set('COMMAND#000001', { ...f.command, endedAt: '2026-10-12T00:00:06.000Z' });
  const page = f.records.get('MONITOR_EVENTS#000001') as { events: { recordedAt: string }[] };
  page.events[0]!.recordedAt = '2026-10-12T00:00:06.000Z';
  const evidence = await f.reader.read(f.session);
  assert.equal(evidence.commands[0]!.endedAt, null);
  assert.equal(evidence.commands[0]!.outputExcerpt, '');
  assert.deepEqual(evidence.events, []);
});
test('corrupt parser, command identity, event sequence and pagination fail closed', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.records.set('COMMAND_PARSER', { ...f.parser, cursor: -1 }),
    (f: ReturnType<typeof fixture>) => f.records.set('COMMAND#000001', { ...f.command, id: randomUUID() }),
    (f: ReturnType<typeof fixture>) =>
      f.records.set('MONITOR_EVENTS#000001', {
        schemaVersion: 1,
        source: randomUUID(),
        after: 0,
        nextSequence: 1,
        events: [],
      }),
    (f: ReturnType<typeof fixture>) => f.repeat(),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.reader.read(f.session));
  }
});
test('empty terminal seal permits no parser but rejects corrupt or nonempty parser evidence', async () => {
  const f = fixture();
  f.records.delete('COMMAND#000001');
  f.records.delete('COMMAND_PARSER');
  const source = f.parser.source;
  const excludedAt = '2026-10-12T00:00:06.000Z';
  const checkpoint = advanceTerminalCheckpoint(
    initialTerminalCheckpoint(terminalReady({ source })),
    terminalPage([{ type: 'dimensions', sequence: 1, recordedAt: excludedAt, columns: 80, rows: 24 }], { source }),
  );
  f.records.set('TERMINAL_SEAL', {
    schemaVersion: 1,
    cutoffAt: end,
    checkpoint,
    cursor: 0,
    pageCount: 0,
    recordedBytes: 0,
    lastAt: null,
    excludedAt,
    complete: true,
  });
  const object = {
    schemaVersion: 1,
    kind: 'sealed_monitor_recording',
    sessionId: f.session.view.id,
    recorderGeneration: 1,
    startedAt: at,
    cutoffAt: end,
    source: null,
    cursor: 0,
    frames: [],
    final: {
      type: 'metrics',
      sample: { at: end, values: { request_rate: 0 } },
      counters: { totalRequests: 0, failedRequests: 0 },
      recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
    },
  };
  const bytes = Buffer.from(JSON.stringify(object));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reference = {
    phase: 'sealed',
    objectKey: `sessions/${f.session.view.id}/metrics/000000001/sealed/empty/000000-000000-${sha256}.json`,
    sha256,
    source: null,
    after: 0,
    nextSequence: 0,
    frameCount: 0,
  };
  const recording = f.records.get('RECORDING') as Record<string, unknown>;
  f.records.set('RECORDING', {
    ...recording,
    status: 'complete',
    reason: null,
    source: null,
    cursor: 0,
    retainUntil: recordingRetainUntil(end, 'sealed'),
    drainDeadlineAt: '2026-10-12T00:00:35.000Z',
    sealed: reference,
  });
  f.session.view.recording = { status: 'complete', reason: null };
  const dynamo = {
    send: async (request: GetCommand | QueryCommand) =>
      request instanceof GetCommand
        ? { Item: { data: f.records.get(request.input.Key!.SK as string) } }
        : { Items: [] },
  } as unknown as DynamoDBDocumentClient;
  const s3 = {
    send: async () => ({ Body: Readable.from([bytes]), ContentLength: bytes.length }),
  } as unknown as S3Client;
  const reader = new RecordedEvidenceReader(dynamo, 'test-sessions', s3, 'test-recordings');
  assert.deepEqual((await reader.read(f.session)).commands, []);
  f.records.set('SEALED_COMMAND_PARSER', initialCommandParser(source));
  assert.deepEqual((await reader.read(f.session)).commands, []);
  f.records.set('RECORDING', { ...(f.records.get('RECORDING') as object), generation: 2 });
  assert.deepEqual((await reader.read(f.session)).commands, []);
  for (const parser of [{ ...initialCommandParser(source), count: 1 }, { corrupt: true }]) {
    f.records.set('SEALED_COMMAND_PARSER', parser);
    await assert.rejects(reader.read(f.session), /Terminal evidence has a gap/);
  }
});

test('private object reader rejects oversize, short and changed bodies and destroys failed streams', async () => {
  const bytes = Buffer.from('{"ok":true}');
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const [length, bodyBytes, maximum] of [
    [bytes.length + 1, bytes, 100],
    [bytes.length, Buffer.from('{"ok":false}'), 100],
    [bytes.length, bytes, 1],
  ] as const) {
    const body = Readable.from([bodyBytes]);
    const client = { send: async () => ({ Body: body, ContentLength: length }) } as unknown as S3Client;
    await assert.rejects(readRecordingObject(client, 'test', 'private', hash, maximum));
    assert.equal(body.destroyed, true);
  }
  const client = {
    send: async () => ({ Body: Readable.from([bytes]), ContentLength: bytes.length }),
  } as unknown as S3Client;
  assert.deepEqual(await readRecordingObject(client, 'test', 'private', hash, 100), { ok: true });
});
