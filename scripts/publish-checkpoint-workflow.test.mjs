import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish-checkpoint-images.yml', import.meta.url), 'utf8');
const buildJob = workflow.slice(workflow.indexOf('  build:'), workflow.indexOf('  publish:'));
const publishJob = workflow.slice(workflow.indexOf('  publish:'));

test('checkpoint publication is manual and has only the required GitHub permissions', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request|schedule):/m);
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(buildJob, /id-token:\s*write/);
  assert.match(publishJob, /^    environment: aws-checkpoint$/m);
  assert.match(publishJob, /^    permissions:\n      contents: read\n      id-token: write\n/m);
  assert.equal((workflow.match(/id-token:\s*write/g) ?? []).length, 1);
});

test('checkpoint publication actions are pinned and deployment commands are absent', () => {
  const actionLines = workflow.split('\n').filter((line) => line.includes('uses:'));
  assert.equal(actionLines.length, 7);
  for (const line of actionLines) assert.match(line, /uses: [^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/);
  assert.doesNotMatch(workflow, /\bcdk\s+(?:bootstrap|deploy)|aws\s+(?:cloudformation|lambda|ecs)\b/);
});

test('untrusted image builds cannot request an OIDC token', () => {
  assert.match(buildJob, /Build and test Challenge image/);
  assert.match(buildJob, /Build and test Monitor images/);
  assert.match(buildJob, /Build and test Gateway image/);
  assert.match(buildJob, /Save tested image bundle/);
  assert.match(buildJob, /Upload tested image bundle/);
  assert.doesNotMatch(buildJob, /Configure temporary AWS credentials|Publish immutable images/);
});

test('the publication job loads the tested bundle before it obtains temporary credentials', () => {
  const downloadPosition = publishJob.indexOf('Download tested image bundle');
  const loadPosition = publishJob.indexOf('Load tested images');
  const credentialsPosition = publishJob.indexOf('Configure temporary AWS credentials');
  const publicationPosition = publishJob.indexOf('Publish immutable images');
  assert.match(publishJob, /^    needs: build$/m);
  assert.ok(downloadPosition >= 0);
  assert.ok(loadPosition > downloadPosition);
  assert.ok(credentialsPosition > loadPosition);
  assert.ok(publicationPosition > credentialsPosition);
  assert.match(publishJob, /AWS_CHECKPOINT_IMAGE_PUBLISHER_ROLE_ARN/);
  assert.match(publishJob, /CHECKPOINT_IMAGE_BUNDLE: artifacts\/checkpoint-images\.tar/);
  assert.match(publishJob, /REQUESTED_REF.*refs\/heads\/main/s);
  assert.doesNotMatch(publishJob, /npm ci|npm run .*:build|docker build/);
});
