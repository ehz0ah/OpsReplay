import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { NodeTransport } from '../src/transport.js';
import { validateCheck } from '../src/checks.js';

test('checkout verifies creation and matching read with a fresh reference', async t => {
  let mode = 'valid';
  const references = new Set<string>();
  let last: { id: string; reference: string; status: string };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST') {
        const { reference } = JSON.parse(Buffer.concat(chunks).toString());
        assert.ok(!references.has(reference));
        references.add(reference);
        last = { id: 'order_1', reference, status: 'confirmed' };
        response.writeHead(201);
      } else response.writeHead(mode === 'read-fails' ? 404 : 200);
      if (mode === 'status-only') response.end('{}');
      else if (mode === 'invalid-json') response.end('invalid');
      else if (mode === 'old-reference') response.end(JSON.stringify({ ...last, reference: 'old' }));
      else if (mode === 'bad-id') response.end(JSON.stringify({ ...last, id: '../private' }));
      else if (mode === 'unconfirmed') response.end(JSON.stringify({ ...last, status: 'pending' }));
      else if (mode === 'wrong-read' && request.method === 'GET') response.end(JSON.stringify({ ...last, id: 'other' }));
      else response.end(JSON.stringify(last));
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const transport = new NodeTransport();
  t.after(async () => { transport.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const check = { kind: 'checkout' as const, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 200 };
  assert.equal(await validateCheck(check, [], transport, new AbortController().signal), true);
  assert.equal(await validateCheck(check, [], transport, new AbortController().signal), true);
  for (mode of ['status-only', 'invalid-json', 'old-reference', 'bad-id', 'unconfirmed', 'wrong-read', 'read-fails']) {
    assert.equal(await validateCheck(check, [], transport, new AbortController().signal), false, mode);
  }
});

test('HTTP transport bounds redirects, headers, streamed bytes, time, and cancellation', async t => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests++;
    if (request.url === '/redirect') response.writeHead(302, { Location: '/followed' }).end();
    else if (request.url === '/large') response.end('x'.repeat(65537));
    else if (request.url === '/headers') response.writeHead(200, { 'X-Large': 'x'.repeat(20000) }).end();
    else if (request.url === '/broken') { response.writeHead(200, { 'Content-Length': '100' }); response.end('partial'); }
    else if (request.url === '/hang') { response.writeHead(200); response.write('partial'); }
    else response.end('ok');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const transport = new NodeTransport();
  t.after(async () => { transport.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const check = (path: string) => ({ method: 'GET' as const, url: base + path, expectStatus: [200], timeoutMs: 100 });
  const signal = new AbortController().signal;
  for (const path of ['/redirect', '/large', '/headers', '/hang', '/broken']) {
    assert.equal(await transport.http(check(path), signal), null, path);
  }
  assert.equal(requests, 5, 'Redirects must not issue another request');
  const controller = new AbortController();
  const hanging = transport.http({ ...check('/hang'), timeoutMs: 30000 }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 20);
  assert.equal(await hanging, null);
  clearTimeout(timer);
  const before = requests;
  assert.equal(await transport.http(check('/'), controller.signal), null);
  assert.equal(requests, before);
  assert.equal((await transport.http(check('/'), signal))?.body, 'ok', 'Cancellation must release socket capacity');
  assert.equal(await transport.tcp('127.0.0.1', (server.address() as AddressInfo).port, 100, signal), true);
  assert.equal(await transport.tcp('example.com', 80, 100, signal), false);
  await assert.rejects(transport.http({ ...check('/'), url: 'http://169.254.170.2/' }, signal), /invalid_config/);
});
