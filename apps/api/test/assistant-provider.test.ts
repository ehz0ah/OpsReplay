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
test('Ark Chat Completions uses the configured URL and the existing bounded protocol', async () => {
  const endpoint = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
  let sent: any;
  const provider = new ChatProvider(
    { endpoint, model: 'test-model', key: async () => 'test-key' },
    async (url, options) => {
      assert.equal(url, endpoint);
      assert.equal(options?.redirect, 'error');
      sent = JSON.parse(String(options?.body));
      return new Response(
        'data: {"choices":[{"delta":{"content":"Inspect logs."}}]}\n\n' +
          'data: {"usage":{"prompt_tokens":40,"completion_tokens":10},"choices":[]}\n\n' +
          'data: [DONE]\n\n',
      );
    },
  );
  const reply = await provider.reply(context, [], 'help', () => {}, AbortSignal.timeout(1000));
  assert.equal(reply.text, 'Inspect logs.');
  assert.deepEqual(reply.usage, { inputTokens: 40, outputTokens: 10 });
  assert.equal(sent.max_completion_tokens, 1200);
  assert.deepEqual(sent.stream_options, { include_usage: true });
  assert.equal(sent.tools[0].function.name, 'propose_command');
  assert.equal(sent.parallel_tool_calls, false);
});
test('endpoint validation rejects unsupported protocols, paths and credential-bearing URLs', () => {
  for (const endpoint of [
    'http://api.example/api/v3/chat/completions',
    'https://user:secret@api.example/api/v3/chat/completions',
    'https://api.example/api/v3/chat/completions?key=secret',
    'https://api.example/api/v3/chat/completions#fragment',
    'https://localhost/api/v3/chat/completions',
    'https://api.example/api/v3/responses',
    'https://api.example/v1/responses',
    'https://api.example/api/v3/chat/completions/',
    'https://api.example/other/chat/completions',
  ])
    assert.throws(() => new ChatProvider({ endpoint, model: 'test', key: async () => 'key' }));
});
test('split typed tool arguments produce one proposal while invalid calls remain text-only', async () => {
  for (const name of ['propose_command', 'execute']) {
    const data =
      [
        {
          choices: [
            {
              delta: {
                content: 'Read the error log.',
                tool_calls: [{ index: 0, id: 'call', function: { name, arguments: '{"command":"cat /var/' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'log/nginx/error.log","rationale":"Inspect failures"}' } },
                ],
              },
            },
          ],
        },
      ]
        .map((v) => 'data: ' + JSON.stringify(v) + '\n\n')
        .join('') + 'data: [DONE]\n\n';
    const provider = new ChatProvider(
      { endpoint: 'https://api.example/v1/chat/completions', model: 'test', key: async () => 'key' },
      async () => new Response(data),
    );
    const result = await provider.reply(context, [], 'help', () => {}, AbortSignal.timeout(1000));
    assert.equal(result.proposal?.command, name === 'propose_command' ? 'cat /var/log/nginx/error.log' : undefined);
  }
});
