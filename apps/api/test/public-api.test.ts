import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { loadPublicApiPolicy, withPublicApiPolicy } from '../src/shared/public-api.js';

const event = (claims: Record<string, unknown>, origin = 'https://unapproved.example') =>
  ({
    headers: { origin },
    requestContext: { authorizer: { claims } },
  }) as unknown as APIGatewayProxyEvent;

test('the public API wrapper accepts only the configured ID-token audience and adds one fixed origin', async () => {
  const seen: unknown[] = [];
  const handler = withPublicApiPolicy(
    async (request) => {
      seen.push(request.requestContext.authorizer?.claims?.sub);
      return {
        statusCode: request.requestContext.authorizer?.claims?.sub ? 200 : 401,
        headers: { 'Cache-Control': 'no-store' },
        body: '{}',
      };
    },
    { allowedOrigin: 'https://app.opsreplay.test', clientId: 'client123' },
  );
  const accepted = await handler(event({ sub: 'owner', token_use: 'id', aud: 'client123' }), {});
  const wrongAudience = await handler(event({ sub: 'owner', token_use: 'id', aud: 'other' }), {});
  const accessToken = await handler(event({ sub: 'owner', token_use: 'access', client_id: 'client123' }), {});
  assert.deepEqual(seen, ['owner', undefined, undefined]);
  assert.equal(accepted.statusCode, 200);
  assert.equal(wrongAudience.statusCode, 401);
  assert.equal(accessToken.statusCode, 401);
  for (const response of [accepted, wrongAudience, accessToken]) {
    assert.equal(response.headers?.['Access-Control-Allow-Origin'], 'https://app.opsreplay.test');
    assert.equal(response.headers?.Vary, 'Origin');
    assert.equal(response.headers?.['Access-Control-Allow-Credentials'], undefined);
  }
});

test('public API configuration accepts an exact HTTPS origin or local development origin only', () => {
  assert.deepEqual(
    loadPublicApiPolicy({
      PUBLIC_API_ALLOWED_ORIGIN: 'https://app.opsreplay.test',
      COGNITO_USER_POOL_CLIENT_ID: 'client123',
    }),
    { allowedOrigin: 'https://app.opsreplay.test', clientId: 'client123' },
  );
  assert.equal(
    loadPublicApiPolicy({
      PUBLIC_API_ALLOWED_ORIGIN: 'http://localhost:3000',
      COGNITO_USER_POOL_CLIENT_ID: 'client123',
    }).allowedOrigin,
    'http://localhost:3000',
  );
  for (const allowedOrigin of [
    '*',
    'null',
    'http://app.opsreplay.test',
    'https://app.opsreplay.test/path',
    'https://user@app.opsreplay.test',
  ]) {
    assert.throws(() =>
      loadPublicApiPolicy({ PUBLIC_API_ALLOWED_ORIGIN: allowedOrigin, COGNITO_USER_POOL_CLIENT_ID: 'client123' }),
    );
  }
  assert.throws(() =>
    loadPublicApiPolicy({
      PUBLIC_API_ALLOWED_ORIGIN: 'https://app.opsreplay.test',
      COGNITO_USER_POOL_CLIENT_ID: 'not-valid!',
    }),
  );
});
