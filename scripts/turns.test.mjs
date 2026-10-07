import assert from 'node:assert/strict';
import test from 'node:test';
import { admitTurn, expireTurn, finishTurn } from './reference/turns.mjs';

const conversation = () => ({ activeTurnId: null, turns: {} });
const first = { id: 'one', hash: 'body-one', workerToken: 'worker-one' };
const second = { id: 'two', hash: 'body-two', workerToken: 'worker-two' };
const completed = { status: 'completed', text: 'Read the log.', proposals: [{ id: 'proposal-one' }] };

for (const scope of ['session', 'review-submission']) {
  test(scope + ': crashed worker expires and an old ID never recalls the provider', () => {
    const state = conversation();
    assert.equal(admitTurn(state, first, 0).type, 'call_provider');
    assert.equal(admitTurn(state, first, 1000).type, 'replay');
    assert.equal(state.turns.one.expiresAt, 60_000);
    assert.equal(admitTurn(state, second, 59_999).type, 'busy');
    assert.equal(admitTurn(state, second, 60_000).type, 'call_provider');
    assert.equal(state.turns.one.status, 'interrupted');
    assert.equal(admitTurn(state, first, 60_001).type, 'replay');
    assert.equal(state.activeTurnId, 'two');
  });
}

test('sweep recovers an idle conversation without a new client request', () => {
  const state = conversation();
  admitTurn(state, first, 0);
  expireTurn(state, 60_000);
  assert.equal(state.activeTurnId, null);
  assert.equal(state.turns.one.status, 'interrupted');
});

test('late worker cannot publish a proposal or clear a newer active turn', () => {
  const state = conversation();
  admitTurn(state, first, 0);
  admitTurn(state, second, 60_000);
  assert.equal(finishTurn(state, 'one', 'worker-one', completed, 60_001, true), false);
  assert.deepEqual(state.turns.one.proposals, []);
  assert.equal(state.activeTurnId, 'two');
  assert.equal(finishTurn(state, 'two', 'wrong-worker', completed, 60_002, true), false);
  assert.equal(state.activeTurnId, 'two');
});

test('completion at expiry loses even before any recovery request', () => {
  const state = conversation();
  admitTurn(state, first, 0);
  assert.equal(finishTurn(state, 'one', 'worker-one', completed, 60_000, true), false);
  assert.equal(state.turns.one.status, 'interrupted');
});

test('successful completion is immutable and request hashing survives interruption', () => {
  const state = conversation();
  admitTurn(state, first, 0);
  assert.equal(finishTurn(state, 'one', 'worker-one', completed, 1000, true), true);
  assert.equal(state.activeTurnId, null);
  assert.equal(finishTurn(state, 'one', 'worker-one', { ...completed, text: 'changed' }, 2000, true), false);
  assert.equal(state.turns.one.text, completed.text);
  assert.equal(admitTurn(state, { ...first, hash: 'changed-body' }, 3000).type, 'conflict');
  const lost = conversation();
  admitTurn(lost, first, 0);
  expireTurn(lost, 60_000);
  assert.equal(admitTurn(lost, { ...first, hash: 'changed-body' }, 60_001).type, 'conflict');
});

test('failed turns and sessions that ended cannot leave runnable proposals', () => {
  for (const [result, allowed] of [
    [{ ...completed, status: 'failed' }, true],
    [completed, false],
  ]) {
    const state = conversation();
    admitTurn(state, first, 0);
    assert.equal(finishTurn(state, 'one', 'worker-one', result, 1000, allowed), true);
    assert.deepEqual(state.turns.one.proposals, []);
    assert.equal(state.activeTurnId, null);
  }
});
