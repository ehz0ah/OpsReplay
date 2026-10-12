import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { createS3PlaybackSigner } from '../src/get-playback/handler.js';
test('real SDK presigning pins temporary credentials and exact date/expiry without AWS calls', async () => {
  let calls = 0;
  // The SDK can resolve an expiring provider twice during its first memoised call.
  // Signing must not resolve it again after the expiry check.
  const expiry = new Date(Date.now() + 20000);
  const client = new S3Client({
    region: 'us-east-1',
    credentials: async () => {
      calls++;
      return {
        accessKeyId: 'LOCALACCESSKEY',
        secretAccessKey: 'local-secret-only',
        sessionToken: 'local-token',
        expiration: expiry,
      };
    },
  });
  const signer = createS3PlaybackSigner(client, 'test-recordings');
  const signal = new AbortController().signal;
  assert.equal(await signer.credentialExpiresAt(signal), expiry.getTime());
  const resolvedCalls = calls;
  assert.ok(resolvedCalls > 0);
  const date = new Date('2026-10-12T00:00:00.000Z');
  const first = new URL(await signer.sign('sessions/test/playback/file.cast', 300, date, signal));
  const second = new URL(await signer.sign('sessions/test/playback/next.cast', 300, date, signal));
  assert.equal(first.protocol, 'https:');
  assert.equal(first.searchParams.get('X-Amz-Date'), '20261012T000000Z');
  assert.equal(first.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(first.searchParams.get('X-Amz-Security-Token'), 'local-token');
  assert.ok(second.searchParams.get('X-Amz-Credential')?.startsWith('LOCALACCESSKEY/'));
  assert.equal(calls, resolvedCalls);
  client.destroy();
});
