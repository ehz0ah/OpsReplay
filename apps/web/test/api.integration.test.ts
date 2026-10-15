import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ApiClient, ApiError, TransportError } from '../src/api.js';
import { parseConfig } from '../src/config.js';
const account = { plan: 'free', planSource: 'default', planExpiresAt: null, activeSessionId: null };
test('public catalogue omits identity while authenticated reads use the current token', async () => {
  const requests: RequestInit[] = [];
  const api = new ApiClient(
    'https://api.example',
    async () => 'current-token',
    async (_url, options) => {
      requests.push(options!);
      return new Response(JSON.stringify(account));
    },
  );
  await api.read('Account', '/v1/me');
  assert.equal((requests[0]!.headers as Record<string, string>).Authorization, 'Bearer current-token');
  assert.equal(requests[0]!.credentials, 'omit');
  const catalog = JSON.parse(
    readFileSync(new URL('../../../packages/contracts/examples/catalog.json', import.meta.url), 'utf8'),
  );
  const publicApi = new ApiClient(
    'https://api.example',
    async () => {
      throw new Error('unexpected identity read');
    },
    async (_url, options) => {
      requests.push(options!);
      return new Response(JSON.stringify(catalog));
    },
  );
  await publicApi.read('Catalog', '/v1/catalog');
  assert.equal((requests[1]!.headers as Record<string, string>).Authorization, undefined);
});
test('invalid private fields and network outcomes do not become successful application data', async () => {
  const invalid = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () => new Response(JSON.stringify({ ...account, secret: 'hidden' })),
  );
  await assert.rejects(invalid.read('Account', '/v1/me'), /public contract/);
  const failure = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () => {
      throw new Error('network');
    },
  );
  await assert.rejects(
    failure.mutate('SessionResponse', '/v1/sessions', { requestId: 'same-request' }),
    TransportError,
  );
  const denied = new ApiClient(
    'https://api.example',
    async () => 'token',
    async () =>
      new Response(
        JSON.stringify({ code: 'ACCESS_DENIED', message: 'Denied', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        { status: 403 },
      ),
  );
  await assert.rejects(denied.read('Account', '/v1/me'), ApiError);
});
test('public configuration rejects credentials, foreign redirects, and non-Cognito identity', () => {
  const config = {
    apiBaseUrl: 'https://api.example/checkpoint',
    cognitoAuthority: 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool_123',
    cognitoClientId: 'abc123',
    cognitoLoginUrl: 'https://opsreplay.auth.ap-southeast-1.amazoncognito.com',
    callbackUrl: 'https://app.example/auth/callback',
    logoutUrl: 'https://app.example/',
  };
  assert.equal(parseConfig(config, 'https://app.example').apiBaseUrl, config.apiBaseUrl);
  for (const patch of [
    { apiBaseUrl: 'https://user:password@api.example' },
    { callbackUrl: 'https://other.example/auth/callback' },
    { cognitoAuthority: 'https://other.example' },
  ])
    assert.throws(() => parseConfig({ ...config, ...patch }, 'https://app.example'));
});

test('default native fetch keeps its browser call binding', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function (this: unknown) {
    assert.ok(this === undefined || this === globalThis, 'Native fetch cannot receive the API client as its receiver');
    return new Response(JSON.stringify(account));
  };
  try {
    assert.deepEqual(
      await new ApiClient('https://api.example', async () => 'token').read('Account', '/v1/me'),
      account,
    );
  } finally {
    globalThis.fetch = original;
  }
});
