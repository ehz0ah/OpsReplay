import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { checkCheckout } from './reference/checkout.mjs';

const check = { kind: 'checkout', baseUrl: 'http://127.0.0.1:80', timeoutMs: 3000 };
const reference = 'fresh-reference';
const order = { id: 'order-1', reference, status: 'confirmed' };
const response = (status, body) => ({ status, body: JSON.stringify(body) });

test('checkout requires creation and a matching order read through the same origin', async () => {
  const calls = [],
    replies = [response(201, order), response(200, order)];
  assert.equal(
    await checkCheckout(check, reference, async (request) => {
      calls.push(request);
      return replies.shift();
    }),
    true,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, check.baseUrl + '/api/checkout');
  assert.deepEqual(calls[0].json, { reference });
  assert.equal(calls[1].url, check.baseUrl + '/api/orders/order-1');
  for (const request of calls) {
    assert.equal(request.redirect, 'error');
    assert.equal(request.timeoutMs, 3000);
    assert.equal(request.maxBytes, 65536);
  }
});

const badCreations = [
  ['status-only stub', response(201, {})],
  ['stale reference', response(201, { ...order, reference: 'old' })],
  ['unfinished checkout', response(201, { ...order, status: 'pending' })],
  ['unsafe identifier', response(201, { ...order, id: '../admin' })],
  ['array body', response(201, [order])],
  ['invalid JSON', { status: 201, body: '{' }],
  ['oversized body', { status: 201, body: ' '.repeat(65537) }],
  ['redirect', { ...response(201, order), redirected: true }],
];
for (const [name, creation] of badCreations) {
  test('checkout rejects ' + name + ' without issuing an order read', async () => {
    let count = 0;
    assert.equal(
      await checkCheckout(check, reference, async () => {
        count++;
        return creation;
      }),
      false,
    );
    assert.equal(count, 1);
  });
}

test('missing, mismatched, and stale stored orders fail despite successful creation', async () => {
  for (const read of [
    response(404, {}),
    response(200, { ...order, id: 'different' }),
    response(200, { ...order, reference: 'old' }),
  ]) {
    const replies = [response(201, order), read];
    assert.equal(await checkCheckout(check, reference, async () => replies.shift()), false);
  }
});

test('checkout transport failure or timeout cannot count as recovery', async () => {
  assert.equal(
    await checkCheckout(check, reference, async () => {
      throw new Error('timeout');
    }),
    false,
  );
});

test('database draft cannot publish with unresolved workload assumptions', () => {
  const read = (file) => JSON.parse(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(read('packages/contracts/schemas/challenge.schema.json'));
  const draft = read('content/challenges/connection-exhaustion/challenge.json');
  assert.equal(validate(draft), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...draft, status: 'published' }), false);
  assert.ok(validate.errors.some((error) => error.instancePath === '/publicationBlockers'));
});
