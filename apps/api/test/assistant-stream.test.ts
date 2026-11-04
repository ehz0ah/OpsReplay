import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../../../packages/contracts/schemas/public.schema.json';
import { streamingHandler } from '../src/assistant/stream-response.js';
import { createAssistantHandler, withSignal } from '../src/assistant/handler.js';
import { AssistantError, AssistantStore } from '../src/assistant/store.js';
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

test('assistant admission failure returns a public JSON fallback before opening the stream', async () => {
  const requestId = randomUUID();
  const request = {
    ...event,
    httpMethod: 'POST',
    resource: '/v1/sessions/{id}/messages',
    pathParameters: { id: randomUUID() },
    body: JSON.stringify({ requestId, text: 'What should I inspect next?' }),
    isBase64Encoded: false,
  } as APIGatewayProxyEvent;
  const store = new AssistantStore({} as DynamoDBDocumentClient, 'sessions');
  store.admit = async (_id, turnId, _text, owner, _signal, allowFresh) => {
    assert.equal(turnId, requestId);
    assert.equal(owner, 'owner');
    assert.equal(allowFresh, true);
    throw new AssistantError('ASSISTANT_UNAVAILABLE');
  };
  const response = await createAssistantHandler(store, {
    reply: async () => {
      throw new Error('The provider must not be called after failed admission.');
    },
  })(request, { getRemainingTimeInMillis: () => 60_000 }, () => {
    assert.fail('A rejected turn must not open an SSE stream.');
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, {
    code: 'ASSISTANT_UNAVAILABLE',
    message: 'The assistant is unavailable. Continue with the terminal and hints.',
    requestId,
  });
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(schema.$id + '#/$defs/Error')!;
  assert.equal(validate(response.body), true, JSON.stringify(validate.errors));
});
