import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { exerciseView, isReviewBundle, reviewResult, prepareReview } from '../src/review.js';
const bundle = JSON.parse(
  readFileSync(new URL('../../../content/reviews/proxy-rollout/review.json', import.meta.url), 'utf8'),
);
test('exercise projection excludes findings, provenance and private publication fields', () => {
  assert.ok(isReviewBundle(bundle));
  assert.deepEqual(
    Object.keys(exerciseView(bundle)).sort(),
    ['id', 'version', 'title', 'tier', 'category', 'plan', 'language', 'context', 'files'].sort(),
  );
  assert.equal(JSON.stringify(exerciseView(bundle)).includes('missing-config-validation'), false);
  assert.equal(prepareReview(bundle).bundle.status, 'published');
});
test('range matching supports overlapping findings and leaves unmatched flags unpenalised', () => {
  const flags = [
    { file: 'deploy.sh', side: 'new' as const, line: 4, concern: 'Restart can stop the working service.' },
    { file: 'deploy.sh', side: 'old' as const, line: 1, concern: 'Other concern' },
  ];
  const result = reviewResult(bundle, flags);
  assert.equal(result.summary.found, 2);
  assert.deepEqual(result.unmatchedFlags, [1]);
  assert.deepEqual(
    result.findings.map((finding) => finding.matchedFlags),
    [[0], [0]],
  );
  assert.deepEqual(reviewResult(bundle, []).summary, { found: 0, missed: 2 });
  assert.throws(() => reviewResult(bundle, [{ ...flags[0]!, line: 999 }]), /diff line/);
});
test('content validation rejects nonexistent finding ranges and duplicate diff line identity', () => {
  assert.equal(isReviewBundle({ ...bundle, findings: [{ ...bundle.findings[0], endLine: 99 }] }), false);
  const duplicate = structuredClone(bundle);
  duplicate.files[0].lines.push(duplicate.files[0].lines[0]);
  assert.equal(isReviewBundle(duplicate), false);
  const badSide = structuredClone(bundle);
  badSide.files[0].lines[0].oldLine = null;
  assert.equal(isReviewBundle(badSide), false);
});
