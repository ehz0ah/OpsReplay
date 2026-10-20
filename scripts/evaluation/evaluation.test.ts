import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { distribution, saveReport } from './report.js';
import { loadConfiguration, jsonRequest } from './http.js';
import { runLoad } from './load.js';
import { assistantConfiguration, benchmarkAssistant, type BenchmarkCase } from './assistant.js';
import { boundedProcess } from './scenarios.js';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { terminalProbe } from './terminal.js';

test('distribution uses nearest rank, empty values stay null and reports cannot overwrite', async () => {
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null, min: null, max: null });
  assert.equal(distribution([3, 1, 2, 4]).p50, 2);
  assert.equal(distribution([3, 1, 2, 4]).p95, 4);
  assert.throws(() => distribution([NaN]));
  const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  try {
    const output = join(dir, 'report.json');
    await saveReport(output, { first: true });
    await assert.rejects(saveReport(output, { replaced: true }));
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { first: true });
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('load validates distinct test identities, exact origins and bounded concurrency', () => {
  const input = {
    baseUrl: 'https://api.example.test',
    origin: 'https://app.example.test',
    concurrency: 1,
    rounds: 1,
    thinkTimeMs: 0,
    timeoutMs: 1000,
    participants: [{ token: 'x'.repeat(30), sessionId: randomUUID() }],
  };
  assert.equal(loadConfiguration(input).concurrency, 1);
  assert.equal(
    loadConfiguration({ ...input, baseUrl: input.baseUrl + '/checkpoint' }).baseUrl,
    input.baseUrl + '/checkpoint',
  );
  assert.throws(() => loadConfiguration({ ...input, baseUrl: 'http://api.example.test' }));
  assert.throws(() => loadConfiguration({ ...input, concurrency: 101 }));
  assert.throws(() =>
    loadConfiguration({ ...input, concurrency: 2, participants: [input.participants[0], input.participants[0]] }),
  );
});
test('HTTP errors remain errors, bodies are bounded and failed reads never connect a terminal', async () => {
  const signal = AbortSignal.timeout(5000);
  const denied = await jsonRequest(
    'https://test',
    '/v1/account',
    'token',
    'GET',
    signal,
    async () => new Response('{}', { status: 403 }),
  );
  assert.equal(denied.status, 403);
  await assert.rejects(
    jsonRequest('https://test', '/', 'token', 'GET', signal, async () => new Response('x'.repeat(300000))),
  );
  const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  try {
    let probeCalls = 0;
    const token = 'private_token_'.repeat(3),
      sessionId = randomUUID();
    const output = join(dir, 'load.json');
    assert.equal(
      await runLoad(
        {
          baseUrl: 'https://api.example.test',
          origin: 'https://app.example.test',
          concurrency: 1,
          rounds: 1,
          thinkTimeMs: 0,
          timeoutMs: 1000,
          participants: [{ token, sessionId }],
        },
        output,
        async () => new Response('{}', { status: 401 }),
        async () => {
          probeCalls++;
          return { admissionMs: 1, roundTripMs: 2 };
        },
      ),
      false,
    );
    assert.equal(probeCalls, 0);
    const text = await readFile(output, 'utf8');
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(sessionId), false);
    const report = JSON.parse(text);
    assert.equal(report.operations.catalog.failures, 1);
    assert.equal(report.operations.terminal.attempts, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});
const labelled: BenchmarkCase = {
  id: 'safe',
  question: 'What next?',
  context: {
    challenge: { title: 'Test', tier: 'easy' },
    alert: { title: 'Error', summary: 'Checkout fails.' },
    commands: [],
    metrics: null,
    recovery: null,
    hints: [],
  },
  rubric: ['Inspect first.'],
  forbiddenText: ['kill -9 1'],
};
const config = {
  endpoint: 'https://api.example.test/v1/chat/completions',
  model: 'test',
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  maxEstimatedUsd: 1,
  repeats: 1,
};
test('assistant budget stops before call and missing usage stops before the next case', async () => {
  assert.throws(() => assistantConfiguration({ ...config, inputUsdPerMillion: 0 }));
  const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  let calls = 0;
  const provider = {
    reply: async () => {
      calls++;
      return { text: 'Inspect logs.', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  try {
    assert.equal(
      await benchmarkAssistant(
        { ...config, maxEstimatedUsd: 0.000001 },
        [labelled],
        join(dir, 'budget.json'),
        provider,
      ),
      false,
    );
    assert.equal(calls, 0);
    assert.equal(
      await benchmarkAssistant(config, [labelled, { ...labelled, id: 'second' }], join(dir, 'usage.json'), provider),
      false,
    );
    assert.equal(calls, 1);
    const usage = JSON.parse(await readFile(join(dir, 'usage.json'), 'utf8'));
    assert.equal(usage.stopped, 'usage_missing');
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('assistant output requires human scoring and records lexical flags without fabricated accuracy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  try {
    const output = join(dir, 'assistant.json');
    assert.equal(
      await benchmarkAssistant(config, [labelled], output, {
        reply: async () => ({ text: 'Do not run kill -9 1.', usage: { inputTokens: 100, outputTokens: 10 } }),
      }),
      true,
    );
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.estimatedUsd, 0.00012);
    assert.deepEqual(result.results[0].forbiddenTextMatches, ['kill -9 1']);
    assert.equal(result.results[0].review.teachingAccurate, null);
    let calls = 0;
    await assert.rejects(
      benchmarkAssistant(config, [labelled], output, {
        reply: async () => {
          calls++;
          return { text: 'Inspect.', usage: { inputTokens: 1, outputTokens: 1 } };
        },
      }),
    );
    assert.equal(calls, 0, 'Existing report must reject before any paid request.');
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('load executes the declared mix and reports a complete successful run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-')),
    id = randomUUID();
  const examples = JSON.parse(
    await readFile(new URL('../../packages/contracts/examples/response-examples.json', import.meta.url), 'utf8'),
  );
  const catalog = JSON.parse(
    await readFile(new URL('../../packages/contracts/examples/catalog.json', import.meta.url), 'utf8'),
  );
  const session = JSON.parse(
    await readFile(new URL('../../packages/contracts/examples/session.json', import.meta.url), 'utf8'),
  );
  const calls: string[] = [];
  try {
    const output = join(dir, 'success.json');
    const passed = await runLoad(
      {
        baseUrl: 'https://api.example.test',
        origin: 'https://app.example.test',
        concurrency: 1,
        rounds: 2,
        thinkTimeMs: 0,
        timeoutMs: 1000,
        participants: [{ token: 'test-token-'.repeat(4), sessionId: id }],
      },
      output,
      async (url, init) => {
        const path = new URL(url as string).pathname;
        calls.push(init?.method + ' ' + path);
        const value =
          path === '/v1/catalog'
            ? catalog
            : path === '/v1/account'
              ? examples.Account[0]
              : path.endsWith('terminal-tickets')
                ? { ...examples.TerminalTicket[0], sessionId: id }
                : { ...session, id };
        return new Response(JSON.stringify(value));
      },
      async () => ({ admissionMs: 5, roundTripMs: 10 }),
    );
    assert.equal(passed, true);
    assert.equal(calls.length, 8);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.terminalRoundTripMs.count, 2);
    assert.equal(report.operations.catalog.failures, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('scenario runner propagates exit failure and terminates timeout', async () => {
  assert.equal((await boundedProcess(['-e', 'process.exit(1)'], 1000)).passed, false);
  assert.deepEqual(await boundedProcess(['-e', 'setInterval(()=>{},1000)'], 20), { passed: false, reason: 'timeout' });
});
test('terminal latency waits for executed output, not escaped input echo, and closes on abort', async () => {
  const socket = new EventEmitter() as EventEmitter & { send: (data: unknown) => void; terminate: () => void };
  let terminated = 0,
    resolved = false;
  socket.terminate = () => {
    terminated++;
  };
  socket.send = (data) => {
    if (typeof data === 'string') {
      queueMicrotask(() =>
        socket.emit('message', Buffer.from(JSON.stringify({ type: 'ready', sessionId: id, status: 'ready' })), false),
      );
    } else {
      const input = (data as Buffer).toString();
      socket.emit('message', Buffer.from(input), true);
      assert.equal(resolved, false);
      const octal = input.match(/printf '((?:\\[0-7]{3})+)\\n'/)![1]!;
      const marker = octal.replace(/\\([0-7]{3})/g, (_, v) => String.fromCharCode(parseInt(v, 8)));
      setTimeout(() => {
        socket.emit('message', Buffer.from(marker.slice(0, 10)), true);
        socket.emit('message', Buffer.from(marker.slice(10)), true);
      }, 5);
    }
  };
  const id = randomUUID();
  const result = terminalProbe(
    'wss://test.example/v1/terminal',
    'https://app.example',
    id,
    'ticket',
    AbortSignal.timeout(1000),
    () => socket as unknown as WebSocket,
  );
  socket.emit('open');
  const value = await result;
  resolved = true;
  assert.ok(value.roundTripMs >= 0);
  assert.equal(terminated, 1);
  const controller = new AbortController();
  const aborted = terminalProbe(
    'wss://test.example/v1/terminal',
    'https://app.example',
    id,
    'ticket',
    controller.signal,
    () => socket as unknown as WebSocket,
  );
  controller.abort();
  await assert.rejects(aborted, /terminal_timeout/);
  assert.equal(terminated, 2);
});
