import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GetObjectCommand, PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { encodeTerminalPage } from '../../../packages/contracts/private/terminal-persistence.js';
import { encodeSealedTerminalPage } from '../../../packages/contracts/private/terminal-sealing.js';
import { terminalPage } from '../../../packages/contracts/private/test-support/terminal-fixture.js';
import { S3TerminalPageArchive } from '../src/terminal-page-archive.js';
import { TerminalRecordingStoreError } from '../src/terminal-recording-store.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const page = terminalPage();
const encoded = encodeTerminalPage(sessionId, 1, 0, page);
const archive = (send: (command: GetObjectCommand | PutObjectCommand, options: unknown) => Promise<unknown>) =>
  new S3TerminalPageArchive({ send } as unknown as S3Client, 'opsreplay-recordings-test');

test('bounded archive validates size, hash, canonical envelope, and preserved bytes', async () => {
  const signal = new AbortController().signal;
  const store = archive(async (command, options) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(command.input.Key, encoded.reference.objectKey);
    assert.equal(command.input.ChecksumMode, 'ENABLED');
    assert.ok((options as { abortSignal: AbortSignal }).abortSignal instanceof AbortSignal);
    assert.equal((options as { abortSignal: AbortSignal }).abortSignal.aborted, false);
    return {
      ContentLength: encoded.body.length,
      Body: Readable.from([encoded.body.subarray(0, 5), encoded.body.subarray(5)]),
    };
  });
  assert.deepEqual(await store.readLive(sessionId, encoded.reference, signal), page);
});

test('rejects truncated, oversized, mismatched, or noncanonical stored objects and destroys the stream', async () => {
  for (const [size, content] of [
    [encoded.body.length - 1, encoded.body],
    [encoded.body.length, encoded.body.subarray(0, encoded.body.length - 1)],
    [encoded.body.length, Buffer.concat([encoded.body, Buffer.from('x')])],
    [encoded.body.length, Buffer.alloc(encoded.body.length, 0)],
  ] as const) {
    const body = Readable.from([content]);
    const store = archive(async () => ({ ContentLength: size, Body: body }));
    await assert.rejects(
      store.readLive(sessionId, encoded.reference),
      (error) => error instanceof TerminalRecordingStoreError && error.code === 'invalid_store',
    );
    assert.ok(body.destroyed);
  }
});

test('preserves authorization and missing-object failures rather than inventing a recording', async () => {
  for (const name of ['NoSuchKey', 'AccessDenied']) {
    const error = new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode: 404 } });
    await assert.rejects(
      archive(async () => {
        throw error;
      }).readLive(sessionId, encoded.reference),
      (actual) =>
        name === 'NoSuchKey'
          ? actual instanceof TerminalRecordingStoreError && actual.code === 'invalid_store'
          : actual === error,
    );
  }
});

test('cancellation destroys a stalled response body instead of blocking the recording runner', async () => {
  const body = new Readable({ read() {} });
  const controller = new AbortController();
  const store = archive(async () => ({ ContentLength: encoded.body.length, Body: body }));
  const reading = store.readLive(sessionId, encoded.reference, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.ok(body.destroyed);
});

test('writes immutable bounded sealed-retention copies and handles exact retries', async () => {
  const expected = encodeSealedTerminalPage(sessionId, 2, page.source, 0, page.events);
  const store = archive(async (command) => {
    assert.ok(command instanceof PutObjectCommand);
    assert.equal(command.input.Tagging, 'opsreplay-retention=sealed');
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.ServerSideEncryption, 'AES256');
    assert.deepEqual(command.input.Body, expected.body);
    throw new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: 412 } });
  });
  assert.deepEqual(await store.putSealed(sessionId, 2, page.source, 0, page.events), expected.reference);
});
