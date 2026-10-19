import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatProvider } from '../src/assistant/provider.js';
const context = {
  challenge: { title: 'Failure', tier: 'easy' },
  alert: { title: 'Errors', summary: 'Checkout fails' },
  commands: [],
  metrics: null,
  recovery: null,
  hints: [],
};
test('provider adapter bounds and decodes split SSE without executing output', async () => {
  let sent: any;
  const source =
    'data: ' +
    JSON.stringify({ choices: [{ delta: { content: 'Inspect logs.' } }] }) +
    '\n\ndata: ' +
    JSON.stringify({ usage: { prompt_tokens: 40, completion_tokens: 10 }, choices: [] }) +
    '\n\ndata: [DONE]\n\n';
  const provider = new ChatProvider(
    { endpoint: 'https://api.example/v1/chat/completions', model: 'test-model', key: async () => 'test-key' },
    async (_url, options) => {
      sent = JSON.parse(String(options?.body));
      return new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(source);
            for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
            controller.close();
          },
        }),
      );
    },
  );
  const deltas: string[] = [];
  const reply = await provider.reply(context, [], 'help', (text) => deltas.push(text), AbortSignal.timeout(1000));
  assert.equal(reply.text, 'Inspect logs.');
  assert.deepEqual(reply.usage, { inputTokens: 40, outputTokens: 10 });
  assert.equal(deltas.join(''), 'Inspect logs.');
  assert.equal(sent.stream, true);
  assert.equal(sent.messages[0].role, 'system');
});
test('missing DONE, invalid text, and provider failures never become completed replies', async () => {
  for (const text of [
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"error":{"message":"secret"}}\n\n',
  ]) {
    const provider = new ChatProvider(
      { endpoint: 'https://api.example/v1/chat/completions', model: 'test', key: async () => 'key' },
      async () => new Response(text),
    );
    await assert.rejects(provider.reply(context, [], 'help', () => {}, AbortSignal.timeout(1000)));
  }
  assert.throws(
    () => new ChatProvider({ endpoint: 'http://localhost/v1/chat/completions', model: 'test', key: async () => 'key' }),
  );
});
