import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AssistantProvider } from '../../apps/api/src/assistant/provider.js';
import { benchmarkAssistant, type BenchmarkCase } from './assistant.js';

const config = {
  endpoint: 'https://api.example.test/v1/chat/completions',
  model: 'test',
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 2,
  maxEstimatedUsd: 1,
  repeats: 1,
};
const example: BenchmarkCase = {
  id: 'logs',
  context: {
    challenge: { title: 'Checkout', tier: 'easy' },
    alert: { title: 'Checkout error', summary: 'Checkout is unavailable.' },
    commands: [],
    metrics: null,
    recovery: null,
    hints: [],
  },
  question: 'Which service log should I inspect?',
  rubric: ['Explain which visible evidence is available.'],
  forbiddenText: [],
};

async function run(provider: AssistantProvider, cases = [example], maxEstimatedUsd = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'opsreplay-assistant-measurements-'));
  try {
    const output = join(directory, 'report.json');
    const passed = await benchmarkAssistant({ ...config, maxEstimatedUsd }, cases, output, provider);
    return { passed, report: JSON.parse(await readFile(output, 'utf8')) };
  } finally {
    await rm(directory, { recursive: true });
  }
}

test('a complete benchmark that exactly uses its budget passes', async () => {
  const { passed, report } = await run({
    reply: async () => ({ text: 'Inspect the service log.', usage: { inputTokens: 500000, outputTokens: 250000 } }),
  });
  assert.equal(passed, true);
  assert.equal(report.stopped, null);
  assert.equal(report.estimatedUsd, 1);
  assert.deepEqual(report.costAccounting, { reportedUsageUsd: 1, reservedUsd: 0 });
  assert.deepEqual(report.summary, {
    plannedAttempts: 1,
    attempted: 1,
    completed: 1,
    providerFailures: 0,
    usageMissing: 0,
    notAttempted: 0,
    providerFailureRate: 0,
    incompleteRate: 0,
  });
});

test('an exhausted budget prevents the next request without losing completed measurements', async () => {
  let calls = 0;
  const { passed, report } = await run(
    {
      reply: async () => {
        calls++;
        return { text: 'Inspect the service log.', usage: { inputTokens: 500000, outputTokens: 250000 } };
      },
    },
    [example, { ...example, id: 'second' }],
  );
  assert.equal(passed, false);
  assert.equal(calls, 1);
  assert.equal(report.stopped, 'estimated_budget');
  assert.equal(report.summary.completed, 1);
  assert.equal(report.summary.notAttempted, 1);
  assert.equal(report.completedDurationMs.count, 1);
});

test('empty or whitespace streaming chunks do not create a first visible response measurement', async () => {
  const { report } = await run({
    reply: async (_context, _history, _question, delta) => {
      delta('');
      delta(' \n');
      return { text: 'Inspect the service log.', usage: { inputTokens: 100, outputTokens: 10 } };
    },
  });
  assert.equal(report.results[0].firstDeltaMs, null);
  assert.deepEqual(report.firstDeltaMs, { count: 0, p50: null, p95: null, min: null, max: null });
});

test('reported usage over the estimate limit still fails the run and stops further requests', async () => {
  let calls = 0;
  const { passed, report } = await run(
    {
      reply: async () => {
        calls++;
        return { text: 'Inspect the service log.', usage: { inputTokens: 1000000, outputTokens: 1 } };
      },
    },
    [example, { ...example, id: 'second' }],
  );
  assert.equal(passed, false);
  assert.equal(calls, 1);
  assert.equal(report.stopped, 'estimated_budget');
  assert.ok(report.estimatedUsd > config.maxEstimatedUsd);
  assert.equal(report.summary.notAttempted, 1);
});

test('visible streaming text contributes one first response sample and complete response latency', async () => {
  const { report } = await run({
    reply: async (_context, _history, _question, delta) => {
      delta('');
      delta('Inspect');
      delta(' the service log.');
      return { text: 'Inspect the service log.', usage: { inputTokens: 100, outputTokens: 10 } };
    },
  });
  assert.equal(report.firstDeltaMs.count, 1);
  assert.equal(report.completedDurationMs.count, 1);
  assert.ok(report.firstDeltaMs.p50 >= 0);
  assert.ok(report.firstDeltaMs.p95 <= report.completedDurationMs.p95);
  assert.equal(report.results[0].review.teachingAccurate, null);
});

test('provider failures keep their cost reservation and attempted-call denominator', async () => {
  let calls = 0;
  const { passed, report } = await run(
    {
      reply: async () => {
        calls++;
        throw new Error('Provider unavailable.');
      },
    },
    [example, { ...example, id: 'second' }],
  );
  assert.equal(passed, false);
  assert.equal(calls, 1);
  assert.equal(report.summary.providerFailureRate, 1);
  assert.equal(report.summary.incompleteRate, 1);
  assert.equal(report.summary.notAttempted, 1);
  assert.equal(report.costAccounting.reportedUsageUsd, 0);
  assert.ok(report.costAccounting.reservedUsd > 0);
  assert.equal(report.estimatedUsd, report.costAccounting.reservedUsd);
  assert.equal(report.results[0].costBasis, 'reservation');
  assert.equal(report.completedDurationMs.count, 0);
});

test('missing usage is distinct from a provider failure and keeps its unknown-cost reservation', async () => {
  const { passed, report } = await run({
    reply: async () => ({ text: 'Inspect the service log.', usage: { inputTokens: 0, outputTokens: 0 } }),
  });
  assert.equal(passed, false);
  assert.equal(report.stopped, 'usage_missing');
  assert.equal(report.summary.providerFailures, 0);
  assert.equal(report.summary.usageMissing, 1);
  assert.equal(report.summary.incompleteRate, 1);
  assert.equal(report.costAccounting.reportedUsageUsd, 0);
  assert.equal(report.estimatedUsd, report.results[0].estimatedUsd);
});

test('mixed results keep failed-call latency out of completed distributions and use all attempts for rates', async () => {
  let calls = 0;
  const { passed, report } = await run(
    {
      reply: async (_context, _history, _question, delta) => {
        calls++;
        if (calls === 3) {
          delta('Partial reply.');
          throw new Error('Reply interrupted.');
        }
        if (calls === 1) delta('Inspect the service log.');
        return {
          text: 'Inspect the service log.',
          usage: { inputTokens: calls * 100, outputTokens: calls * 10 },
        };
      },
    },
    [example, ...['second', 'third', 'fourth'].map((id) => ({ ...example, id }))],
  );
  assert.equal(passed, false);
  assert.equal(calls, 3);
  assert.deepEqual(report.summary, {
    plannedAttempts: 4,
    attempted: 3,
    completed: 2,
    providerFailures: 1,
    usageMissing: 0,
    notAttempted: 1,
    providerFailureRate: 1 / 3,
    incompleteRate: 1 / 3,
  });
  assert.equal(report.durationMs.count, 3);
  assert.equal(report.completedDurationMs.count, 2);
  assert.equal(report.firstDeltaMs.count, 1);
  assert.ok(report.results[2].firstDeltaMs >= 0);
  assert.equal(report.costAccounting.reportedUsageUsd, 0.00036);
  assert.equal(report.costAccounting.reservedUsd, report.results[2].estimatedUsd);
  assert.equal(report.estimatedUsd, report.costAccounting.reportedUsageUsd + report.costAccounting.reservedUsd);
});

test('no attempted request produces null failure rates and no paid usage', async () => {
  let calls = 0;
  const { report } = await run(
    {
      reply: async () => {
        calls++;
        return { text: 'Inspect the service log.', usage: { inputTokens: 100, outputTokens: 10 } };
      },
    },
    [example],
    0.000001,
  );
  assert.equal(calls, 0);
  assert.equal(report.summary.attempted, 0);
  assert.equal(report.summary.notAttempted, 1);
  assert.equal(report.summary.providerFailureRate, null);
  assert.equal(report.summary.incompleteRate, null);
  assert.deepEqual(report.costAccounting, { reportedUsageUsd: 0, reservedUsd: 0 });
});
