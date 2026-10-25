import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { MutationJournal } from '../src/mutation-journal.js';
import { demoUpgradePath } from '../src/demo-upgrade.js';

test('upgrade journal validates saved receipts and isolates owner and mutation kind', async (t) => {
  await t.test('a saved upgrade survives reconstruction and is distinct from end and start', () => {
    const storage = new InMemoryWebStorage(),
      journal = new MutationJournal(storage, 'one');
    const request = journal.begin({ kind: 'upgrade', path: demoUpgradePath, body: { requestId: randomUUID() } });
    assert.ok(request.kind === 'upgrade');
    assert.deepEqual(new MutationJournal(storage, 'one').load('upgrade', demoUpgradePath), request);
    assert.equal(new MutationJournal(storage, 'two').load('upgrade', demoUpgradePath), null);
    assert.equal(journal.load('end', demoUpgradePath), null);
    assert.deepEqual(
      journal.begin({ kind: 'upgrade', path: demoUpgradePath, body: { requestId: randomUUID() } }),
      request,
    );
    journal.complete({ ...request, body: { requestId: randomUUID() } });
    assert.deepEqual(journal.load('upgrade', demoUpgradePath), request);
    journal.complete(request);
    assert.equal(journal.load('upgrade', demoUpgradePath), null);
  });
  await t.test('corrupt records block activation and remain stored for diagnosis', () => {
    for (const corrupt of [
      '{',
      '{}',
      JSON.stringify({ kind: 'end', path: demoUpgradePath, body: { requestId: randomUUID() } }),
      JSON.stringify({ kind: 'upgrade', path: demoUpgradePath, body: { requestId: 'invalid' } }),
      'x'.repeat(4097),
    ]) {
      const storage = new InMemoryWebStorage(),
        journal = new MutationJournal(storage, 'one');
      const key = 'opsreplay:pending:one:upgrade:/v1/demo-upgrade';
      storage.setItem(key, corrupt);
      assert.throws(() => journal.load('upgrade', demoUpgradePath), /Refresh your account/);
      assert.throws(
        () => journal.begin({ kind: 'upgrade', path: demoUpgradePath, body: { requestId: randomUUID() } }),
        /saved activation request/,
      );
      assert.equal(storage.getItem(key), corrupt);
    }
  });
  await t.test('start corruption retains the established attempt recovery message', () => {
    const storage = new InMemoryWebStorage();
    storage.setItem('opsreplay:pending:one:start:/v1/sessions', '{}');
    assert.throws(
      () => new MutationJournal(storage, 'one').load('start', '/v1/sessions'),
      /Resume your active attempt/,
    );
  });
});
