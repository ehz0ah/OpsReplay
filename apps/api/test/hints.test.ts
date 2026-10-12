import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hintAvailableAt, isHintPlan } from '../../../packages/session/src/hints.js';

test('private hint plans require bounded unique IDs in authored delay order', () => {
  assert.equal(isHintPlan([]), true);
  assert.equal(
    isHintPlan([
      { id: 'first-hint', minElapsedMinutes: 3 },
      { id: 'second-hint', minElapsedMinutes: 6 },
    ]),
    true,
  );
  for (const value of [
    [
      { id: 'second-hint', minElapsedMinutes: 6 },
      { id: 'first-hint', minElapsedMinutes: 3 },
    ],
    [
      { id: 'same-hint', minElapsedMinutes: 3 },
      { id: 'same-hint', minElapsedMinutes: 6 },
    ],
    [{ id: 'bad_id', minElapsedMinutes: 3 }],
    [{ id: 'first-hint', minElapsedMinutes: 121 }],
    [{ id: 'first-hint', minElapsedMinutes: 3, text: 'private' }],
    Array.from({ length: 21 }, (_, index) => ({ id: `hint-${index}`, minElapsedMinutes: index })),
  ])
    assert.equal(isHintPlan(value), false);
});

test('hint availability uses the readiness origin and exact authored delay', () => {
  assert.equal(hintAvailableAt('2026-10-13T00:00:00.000Z', 3), '2026-10-13T00:03:00.000Z');
  assert.throws(() => hintAvailableAt('invalid', 3));
  assert.throws(() => hintAvailableAt('2026-10-13T00:00:00.000Z', -1));
  assert.throws(() => hintAvailableAt('2026-10-13T00:00:00.000Z', 2.5));
});
