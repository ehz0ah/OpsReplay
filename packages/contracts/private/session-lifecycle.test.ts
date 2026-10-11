import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  drainDeadlineAt,
  initialSessionLifecycle,
  isSessionLifecycleState,
  lifecycleWorkItem,
} from './session-lifecycle.js';
const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-12T00:00:00.000Z';
test('lifecycle discovery is separate from recording and validates readiness and cleanup relationships', () => {
  const initial = initialSessionLifecycle(id, at);
  assert.ok(isSessionLifecycleState(initial, id));
  assert.equal(lifecycleWorkItem(initial).SK, 'LIFECYCLE');
  assert.equal(lifecycleWorkItem(initial).WorkPK, 'LIFECYCLE');
  assert.equal(drainDeadlineAt(at), '2026-10-12T00:00:30.000Z');
  for (const value of [
    { ...initial, schedulesDeleted: true },
    { ...initial, readyAt: at },
    { ...initial, lastSeenAt: at },
    { ...initial, extra: true },
  ])
    assert.equal(isSessionLifecycleState(value, id), false);
});
