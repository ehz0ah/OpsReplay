import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConfig } from '../../../scripts/prepare-browser-config.js';
test('public configuration preparation validates exact fields and never overwrites another deployment config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opsreplay-public-config-'));
  try {
    const input = join(directory, 'input.json'),
      output = join(directory, 'output.json');
    const config = {
      apiBaseUrl: 'https://abc.execute-api.ap-southeast-1.amazonaws.com/checkpoint',
      cognitoAuthority: 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool_123',
      cognitoClientId: 'client123',
      cognitoLoginUrl: 'https://opsreplay.auth.ap-southeast-1.amazoncognito.com',
      callbackUrl: 'https://abc.cloudfront.net/auth/callback',
      logoutUrl: 'https://abc.cloudfront.net/',
    };
    await writeFile(input, JSON.stringify(config));
    await prepareConfig(input, 'https://abc.cloudfront.net', output);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), config);
    await assert.rejects(prepareConfig(input, 'https://abc.cloudfront.net', output));
    await writeFile(input, JSON.stringify({ ...config, secret: 'not public' }));
    await assert.rejects(prepareConfig(input, 'https://abc.cloudfront.net', join(directory, 'bad.json')), /fields/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
