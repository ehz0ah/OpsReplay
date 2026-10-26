import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { distribution, saveReport } from './report.js';
import { loadConfiguration, jsonRequest } from './http.js';
import { runLoad, runReadLoad } from './load.js';
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
    '/v1/me',
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
  const contract = JSON.parse(
    await readFile(new URL('../../packages/contracts/openapi.json', import.meta.url), 'utf8'),
  );
  assert.ok(contract.paths['/v1/me'].get);
  assert.equal(contract.paths['/v1/account'], undefined);
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
        const value = new Map([
          ['/v1/catalog', catalog],
          ['/v1/me', examples.Account[0]],
          ['/v1/sessions/' + id, { ...session, id }],
          ['/v1/sessions/' + id + '/terminal-tickets', { ...examples.TerminalTicket[0], sessionId: id }],
        ]).get(path);
        if (!value) return new Response('{}', { status: 404 });
        return new Response(JSON.stringify(value));
      },
      async () => ({ admissionMs: 5, roundTripMs: 10 }),
    );
    assert.deepEqual(
      calls,
      Array.from({ length: 2 }, () => [
        'GET /v1/catalog',
        'GET /v1/me',
        'GET /v1/sessions/' + id,
        'POST /v1/sessions/' + id + '/terminal-tickets',
      ]).flat(),
    );
    assert.equal(passed, true);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.terminalRoundTripMs.count, 2);
    assert.equal(report.operations.catalog.failures, 0);
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('load rejects unsafe setup and stops workers after invalid catalogue reads', async (t) => {
  const input = {
    baseUrl: 'https://api.example.test',
    origin: 'https://app.example.test',
    concurrency: 1,
    rounds: 2,
    thinkTimeMs: 0,
    timeoutMs: 1000,
    participants: [{ token: 'private-test-token-'.repeat(3), sessionId: randomUUID() }],
  };
  await t.test('invalid configuration fails before transport or terminal effects', async () => {
    let calls = 0;
    await assert.rejects(
      runLoad(
        { ...input, concurrency: 0 },
        'unused.json',
        async () => {
          calls++;
          throw new Error('Unexpected transport.');
        },
        async () => {
          calls++;
          throw new Error('Unexpected probe.');
        },
      ),
    );
    assert.equal(calls, 0);
  });
  await t.test('an existing report fails before transport or terminal effects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
    try {
      const output = join(dir, 'report.json');
      await saveReport(output, { original: true });
      let calls = 0;
      await assert.rejects(
        runLoad(
          input,
          output,
          async () => {
            calls++;
            throw new Error('Unexpected transport.');
          },
          async () => {
            calls++;
            throw new Error('Unexpected probe.');
          },
        ),
      );
      assert.equal(calls, 0);
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { original: true });
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  for (const [name, transport, status] of [
    ['unauthenticated', async () => new Response('{}', { status: 401 }), 401],
    ['throttled', async () => new Response('{}', { status: 429 }), 429],
    ['invalid JSON', async () => new Response('{'), null],
    ['invalid public schema', async () => new Response('{}'), 200],
    [
      'transport failure',
      async () => {
        throw new Error(input.participants[0]!.token);
      },
      null,
    ],
  ] as const) {
    await t.test(name, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
      try {
        let calls = 0,
          probes = 0;
        const output = join(dir, 'report.json');
        assert.equal(
          await runLoad(
            input,
            output,
            async () => {
              calls++;
              return transport();
            },
            async () => {
              probes++;
              return { admissionMs: 0, roundTripMs: 0 };
            },
          ),
          false,
        );
        assert.equal(calls, 1);
        assert.equal(probes, 0);
        const text = await readFile(output, 'utf8'),
          report = JSON.parse(text);
        assert.equal(report.measurements.length, 1);
        assert.equal(report.measurements[0].status, status);
        assert.equal(report.operations.catalog.failures, 1);
        assert.equal(report.operations.account.attempts, 0);
        assert.equal(report.operations.terminal.attempts, 0);
        for (const secret of [
          input.participants[0]!.token,
          input.participants[0]!.sessionId,
          input.baseUrl,
          input.origin,
        ])
          assert.equal(text.includes(secret), false);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  }
});
async function loadFixtures() {
  const examples = JSON.parse(
    await readFile(new URL('../../packages/contracts/examples/response-examples.json', import.meta.url), 'utf8'),
  );
  const catalog = JSON.parse(
    await readFile(new URL('../../packages/contracts/examples/catalog.json', import.meta.url), 'utf8'),
  );
  const session = JSON.parse(
    await readFile(new URL('../../packages/contracts/examples/session.json', import.meta.url), 'utf8'),
  );
  const input = {
    baseUrl: 'https://api.example.test',
    origin: 'https://app.example.test',
    concurrency: 1,
    rounds: 2,
    thinkTimeMs: 0,
    timeoutMs: 1000,
    participants: [{ token: 'private-load-token-'.repeat(3), sessionId: randomUUID() }],
  };
  const id = input.participants[0]!.sessionId;
  return {
    input,
    catalog,
    account: examples.Account[0],
    session: { ...session, id },
    ticket: { ...examples.TerminalTicket[0], sessionId: id },
  };
}
test('read-only load uses only canonical GETs in every public session state', async (t) => {
  const fixture = await loadFixtures(),
    dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  const schema = JSON.parse(
    await readFile(new URL('../../packages/contracts/schemas/public.schema.json', import.meta.url), 'utf8'),
  );
  try {
    for (const state of schema.$defs.SessionStatus.enum as string[]) {
      await t.test(state, async () => {
        const calls: string[] = [];
        const path = '/v1/sessions/' + fixture.session.id;
        const output = join(dir, state + '.json');
        const routes = new Map([
          ['/v1/catalog', fixture.catalog],
          ['/v1/me', fixture.account],
          [path, { ...fixture.session, status: state }],
        ]);
        assert.equal(
          await runReadLoad(fixture.input, output, async (url, init) => {
            const route = new URL(url as string).pathname;
            calls.push(init?.method + ' ' + route);
            assert.equal(init?.method, 'GET');
            assert.equal(init?.redirect, 'error');
            assert.equal(
              new Headers(init?.headers).get('Authorization'),
              'Bearer ' + fixture.input.participants[0]!.token,
            );
            if (!routes.has(route)) throw new Error('Unexpected route.');
            return new Response(JSON.stringify(routes.get(route)));
          }),
          true,
        );
        assert.deepEqual(
          calls,
          Array.from({ length: 2 }, () => ['GET /v1/catalog', 'GET /v1/me', 'GET ' + path]).flat(),
        );
        const text = await readFile(output, 'utf8'),
          report = JSON.parse(text);
        assert.equal(report.kind, 'existing-session-read-load');
        assert.deepEqual(Object.keys(report.operations), ['catalog', 'account', 'session']);
        assert.equal(Object.hasOwn(report, 'terminalAdmissionMs'), false);
        assert.equal(Object.hasOwn(report, 'terminalRoundTripMs'), false);
        assert.equal(report.measurements.length, 6);
        assert.equal(report.timedOut, false);
        for (const operation of Object.values(report.operations) as {
          attempts: number;
          failures: number;
          durationMs: { count: number };
        }[]) {
          assert.equal(operation.attempts, 2);
          assert.equal(operation.failures, 0);
          assert.equal(operation.durationMs.count, 2);
        }
        for (const secret of [
          fixture.input.participants[0]!.token,
          fixture.session.id,
          fixture.input.baseUrl,
          fixture.input.origin,
        ])
          assert.equal(text.includes(secret), false);
      });
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('load keeps session identity, terminal readiness and ticket guards', async (t) => {
  const fixture = await loadFixtures(),
    dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  const input = { ...fixture.input, rounds: 1 };
  const path = '/v1/sessions/' + fixture.session.id;
  const transportFor =
    (session: unknown, ticket: unknown = fixture.ticket, ticketStatus = 200) =>
    async (url: Parameters<typeof fetch>[0]) => {
      const route = new URL(url as string).pathname;
      const value = new Map([
        ['/v1/catalog', fixture.catalog],
        ['/v1/me', fixture.account],
        [path, session],
        [path + '/terminal-tickets', ticket],
      ]).get(route);
      if (!value) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(value), { status: route.endsWith('/terminal-tickets') ? ticketStatus : 200 });
    };
  try {
    for (const mode of ['read-only', 'terminal'] as const) {
      await t.test(mode + ' rejects another session ID', async () => {
        let probes = 0;
        const output = join(dir, mode + '-identity.json');
        const transport = transportFor({ ...fixture.session, id: randomUUID() });
        const passed =
          mode === 'read-only'
            ? await runReadLoad(input, output, transport)
            : await runLoad(input, output, transport, async () => {
                probes++;
                return { admissionMs: 1, roundTripMs: 1 };
              });
        assert.equal(passed, false);
        assert.equal(probes, 0);
        const report = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(report.operations.session.failures, 1);
        assert.equal(report.measurements.length, 3);
      });
    }
    for (const state of ['provisioning', 'resolved', 'failed', 'ended', 'abandoned', 'error']) {
      await t.test('terminal rejects ' + state, async () => {
        let probes = 0;
        const output = join(dir, state + '.json');
        assert.equal(
          await runLoad(input, output, transportFor({ ...fixture.session, status: state }), async () => {
            probes++;
            return { admissionMs: 1, roundTripMs: 1 };
          }),
          false,
        );
        const report = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(report.kind, 'existing-session-load');
        assert.equal(report.operations.session.failures, 1);
        assert.equal(report.operations.terminal.attempts, 0);
        assert.equal(probes, 0);
      });
    }
    for (const [name, ticket, status, rejectProbe, expectedProbes] of [
      ['ticket denied', {}, 403, false, 0],
      ['ticket wrong session', { ...fixture.ticket, sessionId: randomUUID() }, 200, false, 0],
      ['ticket invalid schema', {}, 200, false, 0],
      ['probe rejection', fixture.ticket, 200, true, 1],
    ] as const) {
      await t.test(name, async () => {
        let probes = 0;
        const output = join(dir, name + '.json');
        assert.equal(
          await runLoad(fixture.input, output, transportFor(fixture.session, ticket, status), async () => {
            probes++;
            if (rejectProbe) throw new Error(fixture.input.participants[0]!.token);
            return { admissionMs: 1, roundTripMs: 1 };
          }),
          false,
        );
        const text = await readFile(output, 'utf8'),
          report = JSON.parse(text);
        assert.equal(probes, expectedProbes);
        assert.equal(report.measurements.length, 4);
        assert.equal(report.operations.terminal.failures, 1);
        assert.equal(report.terminalRoundTripMs.count, 0);
        assert.equal(text.includes(fixture.input.participants[0]!.token), false);
      });
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('read-only load isolates failed workers and honors operation aborts', async (t) => {
  const fixture = await loadFixtures(),
    dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  try {
    await t.test('one account failure does not stop another worker or retry the failure', async () => {
      const second = { token: 'second-private-token-'.repeat(3), sessionId: randomUUID() };
      const input = { ...fixture.input, concurrency: 2, participants: [fixture.input.participants[0]!, second] };
      const output = join(dir, 'workers.json');
      assert.equal(
        await runReadLoad(input, output, async (url, init) => {
          assert.equal(init?.method, 'GET');
          const route = new URL(url as string).pathname;
          const first = new Headers(init?.headers).get('Authorization') === 'Bearer ' + input.participants[0]!.token;
          if (route === '/v1/me' && first) return new Response('{}', { status: 429 });
          const id = first ? fixture.session.id : second.sessionId;
          const value = new Map([
            ['/v1/catalog', fixture.catalog],
            ['/v1/me', fixture.account],
            ['/v1/sessions/' + id, { ...fixture.session, id, status: 'ended' }],
          ]).get(route);
          if (!value) throw new Error('Unexpected route.');
          return new Response(JSON.stringify(value));
        }),
        false,
      );
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.measurements.filter((m: { worker: number }) => m.worker === 1).length, 2);
      assert.equal(report.measurements.filter((m: { worker: number }) => m.worker === 2).length, 6);
      assert.equal(report.operations.account.failures, 1);
      assert.equal(report.operations.session.attempts, 2);
      assert.equal(report.measurements.length, 8);
    });
    await t.test('a bounded request abort fails the run without another request', async () => {
      let calls = 0,
        aborted = false;
      const output = join(dir, 'timeout.json');
      assert.equal(
        await runReadLoad(fixture.input, output, async (_url, init) => {
          calls++;
          const signal = init!.signal!;
          return new Promise<Response>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Request was not aborted.')), 2000);
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                clearTimeout(timer);
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }),
        false,
      );
      assert.equal(calls, 1);
      assert.equal(aborted, true);
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.measurements[0].status, null);
      assert.equal(report.operations.catalog.failures, 1);
      assert.equal(report.timedOut, false, 'Operation timeout is separate from the total lifetime.');
    });
  } finally {
    await rm(dir, { recursive: true });
  }
});
test('read-load CLI selects GET-only behavior and requires explicit execution', async (t) => {
  const fixture = await loadFixtures(),
    dir = await mkdtemp(join(tmpdir(), 'opsreplay-eval-'));
  try {
    const configPath = join(dir, 'config.json'),
      output = join(dir, 'cli.json');
    await writeFile(configPath, JSON.stringify(fixture.input));
    const routes = {
      '/v1/catalog': fixture.catalog,
      '/v1/me': fixture.account,
      ['/v1/sessions/' + fixture.session.id]: { ...fixture.session, status: 'ended' },
    };
    // This child process runs the real CLI with fixture-only fetch, not a local server or AWS.
    const preload =
      'data:text/javascript,' +
      encodeURIComponent(
        `const routes = ${JSON.stringify(routes)}; globalThis.fetch = async (url, init) => { if (init.method !== 'GET') throw new Error('GET only'); const value = routes[new URL(url).pathname]; if (!value) throw new Error('Unexpected route'); return new Response(JSON.stringify(value)); };`,
      );
    const args = [
      '--import',
      'tsx',
      '--import',
      preload,
      'scripts/evaluation/main.ts',
      'read-load',
      configPath,
      output,
    ];
    await t.test('completed-session read CLI succeeds with only fixture GETs', async () => {
      const text = execFileSync(process.execPath, [...args, '--run'], { encoding: 'utf8', timeout: 10000 });
      assert.match(text, /Evaluation run completed/);
      assert.equal(JSON.parse(await readFile(output, 'utf8')).kind, 'existing-session-read-load');
    });
    await t.test('duplicate report is refused and preserves the original result', async () => {
      const original = await readFile(output, 'utf8');
      assert.throws(() => execFileSync(process.execPath, [...args, '--run'], { stdio: 'pipe', timeout: 10000 }));
      assert.equal(await readFile(output, 'utf8'), original);
    });
    await t.test('missing --run cannot create a report', async () => {
      const unused = join(dir, 'unused.json');
      assert.throws(() =>
        execFileSync(process.execPath, [...args.slice(0, -1), unused], { stdio: 'pipe', timeout: 10000 }),
      );
      await assert.rejects(readFile(unused), { code: 'ENOENT' });
    });
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
