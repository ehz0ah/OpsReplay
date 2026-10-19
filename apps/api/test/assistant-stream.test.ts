import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { streamingHandler } from '../src/assistant/stream-response.js';
import { withSignal } from '../src/assistant/handler.js';
const policy = { allowedOrigin: 'https://app.example', clientId: 'client' };
const event = {
  requestContext: { authorizer: { claims: { token_use: 'id', aud: 'client', sub: 'owner' } } },
} as unknown as APIGatewayProxyEvent;
test('Lambda streaming wrapper writes proxy metadata and exact delimiter before SSE', async () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await streamingHandler(async (_event, _context, emit) => {
    emit({ type: 'turn_started', turnId: 'test', sequence: 0, data: { requestId: 'test' } });
    return { statusCode: 200, body: null };
  }, policy)(event, stream, {} as Context);
  const wire = Buffer.concat(chunks),
    at = wire.indexOf(Buffer.alloc(8));
  assert.ok(at > 0);
  assert.equal(JSON.parse(wire.subarray(0, at).toString()).headers['Content-Type'], 'text/event-stream');
  assert.match(wire.subarray(at + 8).toString(), /^event: turn_started\ndata:/);
});
test('wrong token audience strips owner before effects and errors use JSON metadata', async () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  await streamingHandler(async (e) => {
    assert.equal(e.requestContext.authorizer?.claims.sub, undefined);
    return { statusCode: 401, body: { code: 'UNAUTHENTICATED' } };
  }, policy)(
    {
      ...event,
      requestContext: {
        ...event.requestContext,
        authorizer: { claims: { token_use: 'access', aud: 'other', sub: 'owner' } },
      },
    },
    stream,
    {} as Context,
  );
  const wire = Buffer.concat(chunks),
    at = wire.indexOf(Buffer.alloc(8));
  assert.equal(JSON.parse(wire.subarray(0, at).toString()).statusCode, 401);
});
test('adapter ignoring cancellation cannot hold a turn past its deadline', async () => {
  const controller = new AbortController();
  const wait = withSignal(new Promise(() => {}), controller.signal);
  controller.abort(new Error('deadline'));
  await assert.rejects(wait, /deadline/);
});
