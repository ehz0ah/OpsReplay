import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { InMemoryWebStorage } from 'oidc-client-ts';
import { ApiClient, ApiError, TransportError } from '../src/api.js';
import { MutationJournal } from '../src/mutation-journal.js';
import { activateDemoUpgrade, accessDeadline, demoUpgradeAvailable, demoUpgradePath } from '../src/demo-upgrade.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';

const expiry = '2026-10-26T12:00:00.000Z';
const response = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

test('demo activation uses saved identity, validated responses and recoverable requests', async (t) => {
  await t.test('lost responses reuse the same request and leave other mutations untouched', async () => {
    const storage = new InMemoryWebStorage(),
      journal = new MutationJournal(storage, 'learner');
    const start = journal.begin({
      kind: 'start',
      path: '/v1/sessions',
      body: { requestId: randomUUID(), challengeId: 'wrong-upstream-port', challengeVersion: '0.1.2' },
    });
    const ids: string[] = [];
    const api = new ApiClient(
      'https://api.example',
      async () => 'owner-token',
      async (url, request) => {
        assert.equal(url, 'https://api.example/v1/demo-upgrade');
        assert.equal(request?.headers && new Headers(request.headers).get('Authorization'), 'Bearer owner-token');
        const body = JSON.parse(String(request?.body));
        assert.deepEqual(Object.keys(body), ['requestId']);
        ids.push(body.requestId);
        if (ids.length === 1) throw new Error('response lost after commit');
        return response({ changed: true, expiresAt: expiry });
      },
    );
    await assert.rejects(activateDemoUpgrade(api, journal), TransportError);
    const saved = journal.load('upgrade', demoUpgradePath)!;
    assert.equal(saved.body.requestId, ids[0]);
    assert.deepEqual(await activateDemoUpgrade(api, journal), { changed: true, expiresAt: expiry });
    assert.equal(ids[1], ids[0]);
    assert.equal(journal.load('upgrade', demoUpgradePath), null);
    assert.deepEqual(journal.load('start', '/v1/sessions'), start);
    assert.equal(new MutationJournal(storage, 'another').load('upgrade', demoUpgradePath), null);
  });
  await t.test('an unchanged existing grant is a valid result, including indefinite access', async () => {
    const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
    const api = new ApiClient(
      'https://api.example',
      async () => 'token',
      async () => response({ changed: false, expiresAt: null }),
    );
    assert.deepEqual(await activateDemoUpgrade(api, journal), { changed: false, expiresAt: null });
    assert.equal(journal.load('upgrade', demoUpgradePath), null);
  });
  await t.test('only a correlated definite rejection clears the saved request', async () => {
    for (const correlated of [true, false]) {
      const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
      const api = new ApiClient(
        'https://api.example',
        async () => 'token',
        async (_url, request) => {
          const body = JSON.parse(String(request?.body));
          return response(
            { code: 'ACCESS_DENIED', requestId: correlated ? body.requestId : randomUUID(), message: 'Window ended.' },
            403,
          );
        },
      );
      await assert.rejects(activateDemoUpgrade(api, journal), ApiError);
      assert.equal(journal.load('upgrade', demoUpgradePath) === null, correlated);
    }
  });
  await t.test('internal and idempotency errors retain receipts', async () => {
    for (const code of ['INTERNAL_ERROR', 'IDEMPOTENCY_CONFLICT'] as const) {
      const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
      const api = new ApiClient(
        'https://api.example',
        async () => 'token',
        async (_url, request) =>
          response(
            { code, requestId: JSON.parse(String(request?.body)).requestId, message: 'Read current access.' },
            code === 'INTERNAL_ERROR' ? 500 : 409,
          ),
      );
      await assert.rejects(activateDemoUpgrade(api, journal), ApiError);
      assert.ok(journal.load('upgrade', demoUpgradePath));
    }
  });
  await t.test('unvalidated success cannot discard the request or show an activation result', async () => {
    const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
    const api = new ApiClient(
      'https://api.example',
      async () => 'token',
      async () => response({ changed: true, expiresAt: expiry, paymentSucceeded: true }),
    );
    await assert.rejects(activateDemoUpgrade(api, journal));
    assert.ok(journal.load('upgrade', demoUpgradePath));
  });
  await t.test('missing credentials cannot send an activation request', async () => {
    let calls = 0;
    const journal = new MutationJournal(new InMemoryWebStorage(), 'learner');
    const api = new ApiClient(
      'https://api.example',
      async () => null,
      async () => {
        calls++;
        return response({ changed: true, expiresAt: expiry });
      },
    );
    await assert.rejects(activateDemoUpgrade(api, journal), /Sign in/);
    assert.equal(calls, 0);
    assert.ok(journal.load('upgrade', demoUpgradePath));
  });
});

test('access projection follows server plan metadata, with explicit Singapore expiry', () => {
  const free: PublicTypes['Account'] = {
    plan: 'free',
    planSource: 'default',
    planExpiresAt: null,
    activeSessionId: null,
  };
  assert.equal(demoUpgradeAvailable(free), false);
  assert.equal(demoUpgradeAvailable({ ...free, demoUpgradeExpiresAt: null }), false);
  assert.equal(demoUpgradeAvailable({ ...free, demoUpgradeExpiresAt: expiry }), true);
  assert.equal(demoUpgradeAvailable({ ...free, plan: 'pro', demoUpgradeExpiresAt: expiry }), false);
  assert.equal(accessDeadline(null), 'No scheduled expiry');
  assert.equal(accessDeadline(undefined), 'No scheduled expiry');
  assert.match(accessDeadline(expiry), /26 Oct 2026/);
  assert.match(accessDeadline(expiry), /8:00.*SGT/);
});
