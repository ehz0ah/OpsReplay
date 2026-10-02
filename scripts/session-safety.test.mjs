import assert from 'node:assert/strict';
import test from 'node:test';
import { admitRequest } from './reference/requests.mjs';
import { claimProposal, installInput, sendInput, deliverProposal, recordDelivery, refreshProposal } from './reference/terminal.mjs';

for (const operation of ['start', 'review']) {
  test(operation + ': receipt recovery precedes new-version and plan checks', () => {
    const receipt = { ownerId: 'alice', operation, hash: 'version-one-body', result: { id: 'saved' } };
    const request = { actorId: 'alice', ownerId: 'alice', operation, hash: receipt.hash };
    let calls = 0;
    const validateNew = () => { calls++; return { type: 'VERSION_UNAVAILABLE' }; };
    assert.deepEqual(admitRequest(request, receipt, validateNew), { type: 'replay', result: receipt.result });
    assert.equal(calls, 0);
    assert.equal(admitRequest(request, null, validateNew).type, 'VERSION_UNAVAILABLE');
    assert.equal(admitRequest(request, null, () => ({ type: 'ACCESS_DENIED' })).type, 'ACCESS_DENIED');
    assert.equal(admitRequest({ ...request, hash: 'changed' }, receipt, validateNew).type, 'IDEMPOTENCY_CONFLICT');
    assert.equal(admitRequest({ ...request, actorId: 'bob' }, receipt, validateNew).type, 'NOT_FOUND');
    assert.equal(admitRequest({ ...request, actorId: null }, receipt, validateNew).type, 'UNAUTHENTICATED');
    assert.equal(admitRequest({ ...request, operation: 'other' }, receipt, validateNew).type, 'NOT_FOUND');
    assert.equal(calls, 1);
  });
}

const terminal = () => ({ generation: 0, connectionId: null, active: true, prompt: 'empty', deliveries: new Map() });
const proposal = () => ({ id: 'proposal', command: 'pwd', status: 'pending', expiresAt: 1000 });

test('new input generation fences the old gateway and delayed installation', () => {
  const state = terminal(), writes = [];
  assert.equal(installInput(state, 1, 'gateway-a'), true);
  assert.equal(installInput(state, 2, 'gateway-b'), true);
  assert.equal(installInput(state, 1, 'gateway-a'), false);
  assert.equal(installInput(state, 2, 'different-owner'), false);
  assert.equal(sendInput(state, 1, 'gateway-a', 'old', text => writes.push(text)), false);
  assert.equal(sendInput(state, 2, 'gateway-b', 'new', text => writes.push(text)), true);
  assert.deepEqual(writes, ['new']);
  state.active = false;
  assert.equal(sendInput(state, 2, 'gateway-b', 'late', text => writes.push(text)), false);
  assert.equal(installInput(state, 3, 'gateway-c'), false);
});

test('recording ownership alone grants no terminal input permission', () => {
  const state = terminal();
  state.recorderGeneration = 99;
  installInput(state, 1, 'browser-gateway');
  assert.equal(sendInput(state, 99, 'recorder', 'pwd', () => assert.fail()), false);
});

test('busy, partly typed, and unknown prompts reject proposals without writing', () => {
  for (const prompt of ['busy', 'nonempty', 'unknown']) {
    const state = terminal(), item = proposal();
    installInput(state, 1, 'a');
    state.prompt = prompt;
    assert.equal(claimProposal(item, 'token', 0), true);
    const receipt = deliverProposal(state, 1, 'a', item, 0, () => assert.fail());
    assert.equal(receipt.status, 'not_sent');
    assert.equal(recordDelivery(item, receipt), true);
    assert.equal(item.status, 'pending');
  }
});

test('manual input invalidates prompt knowledge before a proposal is accepted', () => {
  const state = terminal(), item = proposal(), writes = [];
  installInput(state, 1, 'a');
  sendInput(state, 1, 'a', 'echo ', text => writes.push(text));
  claimProposal(item, 'token', 0);
  assert.equal(deliverProposal(state, 1, 'a', item, 0, () => assert.fail()).status, 'not_sent');
  assert.deepEqual(writes, ['echo ']);
});

test('duplicate confirmation and lost acknowledgement never write a proposal twice', () => {
  const state = terminal(), item = proposal(), writes = [];
  installInput(state, 1, 'a');
  claimProposal(item, 'token', 0);
  const receipt = deliverProposal(state, 1, 'a', item, 0, text => { writes.push(text); return true; });
  assert.equal(item.status, 'dispatching'); // The gateway has not received the acknowledgement.
  assert.equal(claimProposal(item, 'second-token', 1), false);
  assert.deepEqual(deliverProposal(state, 1, 'a', item, 1, () => assert.fail()), receipt);
  recordDelivery(item, { token: 'token', status: 'unknown' });
  assert.equal(recordDelivery(item, receipt), true);
  assert.equal(item.status, 'accepted');
  assert.equal(recordDelivery(item, { token: 'token', status: 'unknown' }), false);
  assert.deepEqual(writes, ['pwd\n']);
});

test('crash before delivery stays unknown and needs no automatic command retry', () => {
  const item = proposal();
  claimProposal(item, 'token', 0);
  recordDelivery(item, { token: 'token', status: 'unknown' });
  assert.equal(claimProposal(item, 'retry', 1), false);
  const state = terminal();
  installInput(state, 1, 'a');
  assert.equal(deliverProposal(state, 1, 'a', item, 1, () => assert.fail()).status, 'unknown');
});

test('partial writes and terminal write errors preserve uncertainty without replay', () => {
  for (const write of [() => false, () => { throw new Error('PTY lost'); }]) {
    const state = terminal(), item = proposal();
    installInput(state, 1, 'a');
    claimProposal(item, 'token', 0);
    assert.equal(deliverProposal(state, 1, 'a', item, 0, write).status, 'unknown');
    assert.equal(deliverProposal(state, 1, 'a', item, 1, () => assert.fail()).status, 'unknown');
  }
});

test('old generation, expired proposal, and ended session cannot deliver input', () => {
  for (const mode of ['old', 'expired', 'ended']) {
    const state = terminal(), item = proposal();
    installInput(state, 1, 'a');
    claimProposal(item, 'token', 0);
    if (mode === 'old') installInput(state, 2, 'b');
    if (mode === 'ended') state.active = false;
    assert.equal(deliverProposal(state, 1, 'a', item, mode === 'expired' ? 1000 : 0, () => assert.fail()).status, 'not_sent');
  }
});

test('stale delivery token cannot overwrite a newer explicit confirmation', () => {
  const item = proposal();
  claimProposal(item, 'one', 0);
  recordDelivery(item, { token: 'one', status: 'not_sent' });
  claimProposal(item, 'two', 1);
  assert.equal(recordDelivery(item, { token: 'one', status: 'accepted' }), false);
  assert.equal(item.status, 'dispatching');
});

test('dispatch timeout is fixed and expiry never erases an uncertain delivery', () => {
  const item = proposal();
  claimProposal(item, 'token', 0);
  assert.equal(claimProposal(item, 'duplicate', 4999), false);
  assert.equal(item.ackDeadlineAt, 5000);
  assert.equal(refreshProposal(item, 5000), 'unknown');
  assert.equal(refreshProposal(item, 9999), 'unknown');
  assert.equal(recordDelivery(item, { token: 'token', status: 'accepted' }), true);
  assert.equal(refreshProposal(item, 10000), 'accepted');
  const unsent = proposal();
  assert.equal(claimProposal(unsent, 'late', 1000), false);
  assert.equal(unsent.status, 'expired');
});
