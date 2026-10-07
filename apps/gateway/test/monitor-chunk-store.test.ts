import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import type { MonitorFrame, MonitorMetricFrame } from '../src/monitor-client.js';
import { MonitorChunkStoreError, S3MonitorChunkStore } from '../src/monitor-chunk-store.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const source = '22222222-2222-4222-8222-222222222222';
const startedAt = '2026-10-07T00:00:00.000Z';

function metric(at: string): MonitorMetricFrame {
  return {
    type: 'metrics',
    sample: { at, values: { request_rate: 1, error_rate: 100, latency_p95_ms: 4 } },
    counters: { totalRequests: 5, failedRequests: 5 },
    recovery: { state: 'failing', sustainedSeconds: 0, requiredSeconds: 60 },
  };
}

function frame(sequence: number, recordedAt: string): MonitorFrame {
  return { source, sequence, recordedAt, payload: metric(recordedAt) };
}

function serviceError(name: string, status: number): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status } });
}

function storeWith(send: (command: PutObjectCommand, options: unknown) => Promise<unknown>) {
  return new S3MonitorChunkStore({ send } as unknown as S3Client, 'opsreplay-recordings-test');
}

function chunkError(code: MonitorChunkStoreError['code']): (error: unknown) => boolean {
  return (error) => error instanceof MonitorChunkStoreError && error.code === code;
}

test('writes a content-addressed immutable monitor page with an S3 checksum', async () => {
  const calls: { command: PutObjectCommand; options: unknown }[] = [];
  const store = storeWith(async (command, options) => {
    calls.push({ command, options });
    return {};
  });
  const signal = new AbortController().signal;
  const value = {
    startedAt,
    source,
    after: 0,
    nextSequence: 2,
    frames: [frame(1, '2026-10-07T00:00:01.000Z'), frame(2, '2026-10-07T00:00:02.000Z')],
  };

  const reference = await store.putLive(sessionId, 7, value, signal);

  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.command instanceof PutObjectCommand);
  assert.deepEqual(calls[0]!.options, { abortSignal: signal });
  const input = calls[0]!.command.input;
  assert.equal(input.Bucket, 'opsreplay-recordings-test');
  assert.equal(input.IfNoneMatch, '*');
  assert.equal(input.ServerSideEncryption, 'AES256');
  assert.equal(input.ContentType, 'application/json; charset=utf-8');
  assert.ok(Buffer.isBuffer(input.Body));
  const body = input.Body as Buffer;
  const sha256 = createHash('sha256').update(body).digest('hex');
  assert.equal(input.ChecksumSHA256, createHash('sha256').update(body).digest('base64'));
  assert.deepEqual(reference, {
    phase: 'live',
    objectKey: `sessions/${sessionId}/metrics/000000007/live/${source}/000001-000002-${sha256}.json`,
    sha256,
    source,
    after: 0,
    nextSequence: 2,
    frameCount: 2,
  });
  assert.deepEqual(JSON.parse(body.toString('utf8')), {
    schemaVersion: 1,
    kind: 'monitor_page',
    sessionId,
    recorderGeneration: 7,
    ...value,
  });
});

test('treats an existing content-addressed object as an idempotent success', async () => {
  let calls = 0;
  const store = storeWith(async () => {
    calls++;
    throw serviceError('PreconditionFailed', 412);
  });

  const reference = await store.putLive(sessionId, 1, {
    startedAt,
    source,
    after: 0,
    nextSequence: 1,
    frames: [frame(1, '2026-10-07T00:00:01.000Z')],
  });

  assert.equal(calls, 1);
  assert.equal(reference.nextSequence, 1);
});

test('uses canonical JSON so object identity does not depend on metric key order', async () => {
  const keys: string[] = [];
  const store = storeWith(async (command) => {
    keys.push(command.input.Key!);
    return {};
  });
  const first = frame(1, '2026-10-07T00:00:01.000Z');
  const second = structuredClone(first);
  first.payload = metric(first.recordedAt);
  second.payload = {
    ...metric(second.recordedAt),
    sample: {
      at: second.recordedAt,
      values: { latency_p95_ms: 4, error_rate: 100, request_rate: 1 },
    },
  };

  await store.putLive(sessionId, 1, { startedAt, source, after: 0, nextSequence: 1, frames: [first] });
  await store.putLive(sessionId, 1, { startedAt, source, after: 0, nextSequence: 1, frames: [second] });

  assert.equal(keys[0], keys[1]);
});

test('retries one S3 conditional conflict and obeys cancellation before the retry', async () => {
  let calls = 0;
  const retrying = storeWith(async () => {
    calls++;
    if (calls === 1) throw serviceError('ConditionalRequestConflict', 409);
    return {};
  });
  const value = {
    startedAt,
    source,
    after: 0,
    nextSequence: 1,
    frames: [frame(1, '2026-10-07T00:00:01.000Z')],
  };
  await retrying.putLive(sessionId, 1, value);
  assert.equal(calls, 2);

  const controller = new AbortController();
  calls = 0;
  const cancelled = storeWith(async () => {
    calls++;
    controller.abort();
    throw serviceError('ConditionalRequestConflict', 409);
  });
  await assert.rejects(cancelled.putLive(sessionId, 1, value, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('writes an empty canonical sealed recording and rejects invalid streams', async () => {
  const commands: PutObjectCommand[] = [];
  const store = storeWith(async (command) => {
    commands.push(command);
    return {};
  });
  const sealed = {
    startedAt,
    cutoffAt: startedAt,
    source: null,
    cursor: 0,
    frames: [],
    final: metric(startedAt),
  };

  const reference = await store.putSealed(sessionId, 3, sealed);
  assert.equal(reference.objectKey.includes('/sealed/empty/000000-000000-'), true);
  assert.equal(reference.frameCount, 0);

  await assert.rejects(
    store.putLive(sessionId, 3, {
      startedAt,
      source,
      after: 0,
      nextSequence: 2,
      frames: [frame(1, '2026-10-07T00:00:01.000Z')],
    }),
    chunkError('invalid_chunk'),
  );
  await assert.rejects(
    store.putSealed(sessionId, 3, {
      ...sealed,
      cutoffAt: '2026-10-06T23:59:59.000Z',
      final: metric('2026-10-06T23:59:59.000Z'),
    }),
    chunkError('invalid_chunk'),
  );
  assert.equal(commands.length, 1);
});

test('does not hide S3 authorization failures or retry repeated conflicts', async () => {
  let calls = 0;
  const denied = storeWith(async () => {
    throw serviceError('AccessDenied', 403);
  });
  await assert.rejects(
    denied.putLive(sessionId, 1, {
      startedAt,
      source,
      after: 0,
      nextSequence: 1,
      frames: [frame(1, '2026-10-07T00:00:01.000Z')],
    }),
    { name: 'AccessDenied' },
  );

  const conflicts = storeWith(async () => {
    calls++;
    throw serviceError('ConditionalRequestConflict', 409);
  });
  await assert.rejects(
    conflicts.putLive(sessionId, 1, {
      startedAt,
      source,
      after: 0,
      nextSequence: 1,
      frames: [frame(1, '2026-10-07T00:00:01.000Z')],
    }),
    { name: 'ConditionalRequestConflict' },
  );
  assert.equal(calls, 2);
});
