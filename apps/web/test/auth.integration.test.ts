import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OidcClient, InMemoryWebStorage, User } from 'oidc-client-ts';
import { createHash } from 'node:crypto';
import { authSettings, userIdentity, returnPath, AuthSession } from '../src/auth/session.js';
const config = {
  apiBaseUrl: 'https://api.example',
  cognitoAuthority: 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool_123',
  cognitoClientId: 'publicclient',
  cognitoLoginUrl: 'https://opsreplay.auth.ap-southeast-1.amazoncognito.com',
  callbackUrl: 'https://app.example/auth/callback',
  logoutUrl: 'https://app.example/',
};
test('authorization requests use code flow, S256 PKCE, stored state and an explicit nonce', async () => {
  const client = new OidcClient(authSettings(config, new InMemoryWebStorage()));
  const request = await client.createSigninRequest({
    nonce: 'nonce-for-test',
    state: { path: '/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  });
  const url = new URL(request.url);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), config.callbackUrl);
  assert.equal(url.searchParams.get('nonce'), 'nonce-for-test');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(request.state.code_verifier!).digest('base64url'),
  );
  assert.equal(url.searchParams.get('client_secret'), null);
  assert.ok(url.searchParams.get('state'));
  await assert.rejects(client.processSigninResponse(config.callbackUrl + '?code=fake&state=unregistered'), /state/i);
});
test('expired or mismatched ID tokens cannot be used as the displayed identity', () => {
  const now = Date.now();
  const payload = {
    iss: config.cognitoAuthority,
    aud: config.cognitoClientId,
    sub: 'learner',
    token_use: 'id',
    exp: Math.floor(now / 1000) + 100,
  };
  const user = (patch: object) =>
    new User({
      id_token:
        Buffer.from('{}').toString('base64url') +
        '.' +
        Buffer.from(JSON.stringify({ ...payload, ...patch })).toString('base64url') +
        '.signature',
      access_token: 'token',
      token_type: 'Bearer',
      profile: { sub: 'learner', iss: config.cognitoAuthority, aud: config.cognitoClientId, exp: payload.exp, iat: 0 },
    });
  assert.deepEqual(userIdentity(user({}), config, now), { sub: 'learner' });
  for (const patch of [
    { aud: 'other' },
    { token_use: 'access' },
    { sub: 'another' },
    { exp: Math.floor(now / 1000) },
    { iss: 'https://another.example' },
  ])
    assert.equal(userIdentity(user(patch), config, now), null);
});
test('return navigation cannot become an open redirect', () => {
  assert.equal(returnPath('//other.example'), '/');
  assert.equal(returnPath('https://other.example'), '/');
  assert.equal(
    returnPath('/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    '/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
});

test('concurrent API calls share one refresh and logout never puts an ID token in the URL', async () => {
  const session = new AuthSession(config, new InMemoryWebStorage());
  const token = (expired: boolean) =>
    Buffer.from('{}').toString('base64url') +
    '.' +
    Buffer.from(
      JSON.stringify({
        iss: config.cognitoAuthority,
        aud: config.cognitoClientId,
        sub: 'learner',
        token_use: 'id',
        exp: Math.floor(Date.now() / 1000) + (expired ? -1 : 600),
      }),
    ).toString('base64url') +
    '.signature';
  let user: User | null = new User({
    id_token: token(true),
    access_token: 'access',
    refresh_token: 'refresh',
    token_type: 'Bearer',
    profile: { sub: 'learner', iss: config.cognitoAuthority, aud: config.cognitoClientId, exp: 1, iat: 0 },
  });
  let refreshes = 0;
  session.manager.getUser = async () => user;
  session.manager.signinSilent = async () => {
    refreshes++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    user = new User({ ...user!, id_token: token(false) });
    return user;
  };
  session.manager.removeUser = async () => {
    user = null;
  };
  session.manager.revokeTokens = async () => {
    throw new Error('unavailable');
  };
  const tokens = await Promise.all(Array.from({ length: 8 }, () => session.token()));
  assert.equal(refreshes, 1);
  assert.ok(tokens.every((value) => value === tokens[0] && value !== null));
  const url = new URL(await session.signOut());
  assert.equal(user, null);
  assert.equal(url.searchParams.get('id_token_hint'), null);
  assert.equal(url.searchParams.get('logout_uri'), config.logoutUrl);
});
