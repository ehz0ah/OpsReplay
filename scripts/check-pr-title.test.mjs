import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedPullRequestTypes, validatePullRequestTitle } from './check-pr-title.mjs';

const script = fileURLToPath(new URL('check-pr-title.mjs', import.meta.url));

for (const title of [
  ...allowedPullRequestTypes.map((type) => `${type}: update repository`),
  'feat(infra): add checkpoint foundation',
  'feat(api)!: change session response',
  'fix!: change error contract',
  'build(deps): update AWS SDK',
]) {
  test(`accepts ${title}`, () => {
    assert.equal(validatePullRequestTitle(title), null);
  });
}

test('command reads the title from PR_TITLE and reports invalid input', () => {
  const valid = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, PR_TITLE: 'chore(repo): add contribution templates' },
  });
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, PR_TITLE: 'Add contribution templates' },
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /type\(scope\): summary/);

  const environment = { ...process.env };
  delete environment.PR_TITLE;
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8', env: environment });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /type\(scope\): summary/);
});

for (const title of [
  'add checkpoint foundation',
  'feature(infra): add checkpoint foundation',
  'Feat(infra): add checkpoint foundation',
  'feat(): add checkpoint foundation',
  'feat(infra):add checkpoint foundation',
  'feat(infra): ',
  'feat(infra): add checkpoint foundation ',
  'feat(infra): add checkpoint\nfoundation',
]) {
  test(`rejects ${JSON.stringify(title)}`, () => {
    assert.match(validatePullRequestTitle(title), /type\(scope\): summary/);
  });
}
