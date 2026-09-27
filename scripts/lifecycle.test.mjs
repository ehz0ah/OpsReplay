import assert from 'node:assert/strict';
import test from 'node:test';
import { nextStartupAction, nextFinalisationAction, acceptRecordingComplete } from './reference/lifecycle.mjs';

const start = () => ({
  status: 'provisioning', provisioningDeadlineAt: 180_000, timeLimitMs: 1_200_000,
  taskArn: null, launchArguments: { clientToken: 'request-1', taskDefinition: 'pinned:1', secret: 'test-only' },
});

// The fake task service retains client-token identity across handler crashes.
for (const interruptedAfter of ['receipt', 'schedule', 'launch', 'arn', 'ready']) {
  test('startup resumes after ' + interruptedAfter + ' without a browser retry', () => {
    const session = start();
    const external = { scheduleAt: null, taskArn: null, healthy: true, recorderAttached: true };
    const tasks = new Map();
    const effects = [];
    function step(now) {
      const action = nextStartupAction(session, external, now);
      effects.push(action.type);
      if (action.type === 'set_schedule') external.scheduleAt = action.at;
      if (action.type === 'launch') {
        const key = action.arguments.clientToken;
        if (!tasks.has(key)) tasks.set(key, 'task-1');
        external.taskArn = tasks.get(key);
      }
      if (action.type === 'save_task') session.taskArn = action.arn;
      if (action.type === 'mark_ready') Object.assign(session, { status: 'ready', readyAt: action.readyAt, endsAt: action.endsAt });
      return action;
    }
    const beforeCrash = ['receipt', 'schedule', 'launch', 'arn', 'ready'].indexOf(interruptedAfter);
    for (let i = 0; i < beforeCrash; i++) step(1000);
    // No handler-local data survives. The scheduled sweep reads persisted state.
    for (let i = 0; i < 6; i++) step(2000);
    assert.equal(session.status, 'ready');
    assert.equal(session.taskArn, 'task-1');
    assert.equal(external.scheduleAt, session.endsAt);
    assert.equal(tasks.size, 1);
    assert.ok(effects.indexOf('set_schedule') < effects.indexOf('launch'));
  });
}

test('uncertain launch repeats identical arguments only within the deadline', () => {
  const session = start();
  const external = { scheduleAt: 180_000, taskArn: null, healthy: false };
  const first = nextStartupAction(session, external, 1);
  assert.equal(first.type, 'launch');
  assert.deepEqual(nextStartupAction(structuredClone(session), external, 179_999), first);
  assert.deepEqual(nextStartupAction(session, external, 180_000), { type: 'start_failed' });
  session.status = 'error';
  assert.deepEqual(nextStartupAction(session, external, 180_001), { type: 'wait' });
});

test('readiness waits for a recorder even with a healthy monitor', () => {
  const session = { ...start(), taskArn: 'task-1' };
  assert.equal(nextStartupAction(session, { scheduleAt: 180_000, healthy: true }, 1000).type, 'wait');
});

const drain = () => ({ status: 'draining', reason: null, generation: 2, leaseExpiresAt: 45_000, drainDeadlineAt: 30_000 });
const receipt = { generation: 2, allDataSaved: true, hasGaps: false };

test('outcome waits for saved evidence before stop, schedule deletion, and finalisation', () => {
  const session = { status: 'ended', finalised: false };
  const observed = { taskStopped: false, scheduleExists: true };
  const recording = drain();
  assert.equal(nextFinalisationAction(session, recording, observed, 1000).type, 'wait');
  const sealed = acceptRecordingComplete(recording, receipt, 2000);
  assert.equal(nextFinalisationAction(session, sealed, observed, 2000).type, 'stop_task');
  observed.taskStopped = true;
  assert.equal(nextFinalisationAction(session, sealed, observed, 2001).type, 'delete_schedule');
  observed.scheduleExists = false;
  assert.equal(nextFinalisationAction(session, sealed, observed, 2002).type, 'finalise');
  session.finalised = true;
  assert.equal(nextFinalisationAction(session, sealed, observed, 2003).type, 'wait');
});

test('lost task or expired drain seals an incomplete recording before cleanup', () => {
  for (const [observed, now, reason] of [
    [{ taskStopped: true }, 1000, 'task_lost'],
    [{ taskStopped: false }, 30_000, 'drain_timeout'],
  ]) {
    const session = { status: 'failed' };
    assert.deepEqual(nextFinalisationAction(session, drain(), observed, now), { type: 'seal_incomplete', reason });
    const sealed = { ...drain(), status: 'incomplete', reason };
    assert.deepEqual(acceptRecordingComplete(sealed, receipt, now + 1), sealed);
    assert.notEqual(nextFinalisationAction(session, sealed, observed, now).type, 'wait');
  }
});

test('a task found after finalisation is stopped without counting the result again', () => {
  const session = { status: 'error', finalised: true };
  const recording = { ...drain(), status: 'incomplete', reason: 'task_lost' };
  assert.equal(nextStartupAction(session, { taskArn: 'late-task' }, 200_000).type, 'wait');
  assert.equal(nextFinalisationAction(session, recording, { taskStopped: false }, 200_000).type, 'stop_task');
  assert.equal(nextFinalisationAction(session, recording, { taskStopped: true, scheduleExists: false }, 200_001).type, 'wait');
});

test('stale, incomplete, gapped, and expired recorder acknowledgements cannot seal data', () => {
  const recording = drain();
  for (const [ack, now] of [
    [{ ...receipt, generation: 1 }, 1000],
    [{ ...receipt, allDataSaved: false }, 1000],
    [{ ...receipt, hasGaps: true }, 1000],
    [receipt, 30_000],
  ]) assert.deepEqual(acceptRecordingComplete(recording, ack, now), recording);
  const expiredLease = { ...recording, leaseExpiresAt: 500 };
  assert.deepEqual(acceptRecordingComplete(expiredLease, receipt, 1000), expiredLease);
});

test('saved ARN does not skip timer repair and an old timer cannot end a ready session', () => {
  const session = { ...start(), taskArn: 'task-1' };
  assert.equal(nextStartupAction(session, { scheduleAt: null }, 1000).type, 'set_schedule');
  Object.assign(session, { status: 'ready', endsAt: 1_210_000 });
  assert.deepEqual(nextStartupAction(session, { scheduleAt: 180_000 }, 180_000), { type: 'set_schedule', at: 1_210_000 });
  assert.deepEqual(nextStartupAction(session, { scheduleAt: null }, 1_210_000), { type: 'time_limit' });
});
