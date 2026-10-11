import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { encodeTerminalPage } from '../../../packages/contracts/private/terminal-persistence.js';
import { terminalPage } from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { S3TerminalChunkStore, TerminalChunkStoreError } from '../src/terminal-chunk-store.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const error = (name: string, status: number) =>
  new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: status } });
const storeWith = (send: (command: PutObjectCommand, options: unknown) => Promise<unknown>) =>
  new S3TerminalChunkStore({ send } as unknown as S3Client, 'opsreplay-recordings-test');

test('uploads the exact immutable private page with checksum, encryption, and provisional retention', async () => {
  const calls: { command: PutObjectCommand; options: unknown }[] = [];
  const store = storeWith(async (command, options) => {
    calls.push({ command, options });
    return {};
  });
  const signal = new AbortController().signal;
  const page = terminalPage();
  const expected = encodeTerminalPage(sessionId, 7, 0, page);
  const reference = await store.putPage(sessionId, 7, 0, page, signal);
  assert.deepEqual(reference, expected.reference);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options, { abortSignal: signal });
  const input = calls[0]!.command.input;
  assert.equal(input.Bucket, 'opsreplay-recordings-test');
  assert.equal(input.Key, reference.objectKey);
  assert.deepEqual(input.Body, expected.body);
  assert.equal(input.ContentLength, expected.body.byteLength);
  assert.equal(input.ChecksumSHA256, createHash('sha256').update(expected.body).digest('base64'));
  assert.equal(input.IfNoneMatch, '*');
  assert.equal(input.ServerSideEncryption, 'AES256');
  assert.equal(input.ContentType, 'application/json; charset=utf-8');
  assert.equal(input.CacheControl, 'no-store');
  assert.equal(input.Tagging, 'opsreplay-retention=provisional');
  assert.deepEqual(input.Metadata, { schema: '1', sha256: reference.sha256, phase: 'live' });
});

test('duplicate content is successful and one conditional conflict can retry', async () => {
  let calls = 0;
  const existing = storeWith(async () => {
    calls++;
    throw error('PreconditionFailed', 412);
  });
  assert.equal((await existing.putPage(sessionId, 1, 0, terminalPage())).nextSequence, 1);
  assert.equal(calls, 1);
  calls = 0;
  const conflict = storeWith(async () => {
    if (++calls === 1) throw error('ConditionalRequestConflict', 409);
    return {};
  });
  await conflict.putPage(sessionId, 1, 0, terminalPage());
  assert.equal(calls, 2);
});

test('does not hide authorization or transport errors and bounds conflict retries', async () => {
  for (const failure of [error('AccessDenied', 403), new Error('Connection lost')]) {
    let calls = 0;
    await assert.rejects(
      storeWith(async () => {
        calls++;
        throw failure;
      }).putPage(sessionId, 1, 0, terminalPage()),
      (actual) => actual === failure,
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    storeWith(async () => {
      calls++;
      throw error('ConditionalRequestConflict', 409);
    }).putPage(sessionId, 1, 0, terminalPage()),
    { name: 'ConditionalRequestConflict' },
  );
  assert.equal(calls, 2);
});

test('rejects invalid or empty pages before I/O and obeys cancellation before a retry', async () => {
  let calls = 0;
  const store = storeWith(async () => {
    calls++;
    return {};
  });
  for (const [id, generation, after, page] of [
    ['invalid', 1, 0, terminalPage()],
    [sessionId, 0, 0, terminalPage()],
    [sessionId, 1, 2, terminalPage()],
    [sessionId, 1, 1, terminalPage([], { nextSequence: 1 })],
  ] as const) {
    await assert.rejects(
      store.putPage(id, generation, after, page),
      (failure) => failure instanceof TerminalChunkStoreError && failure.code === 'invalid_page',
    );
  }
  assert.equal(calls, 0);
  const controller = new AbortController();
  const cancelled = storeWith(async () => {
    calls++;
    controller.abort();
    throw error('ConditionalRequestConflict', 409);
  });
  await assert.rejects(cancelled.putPage(sessionId, 1, 0, terminalPage(), controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.throws(
    () => new S3TerminalChunkStore({} as S3Client, 'invalid bucket'),
    (failure) => failure instanceof TerminalChunkStoreError && failure.code === 'invalid_config',
  );
});
