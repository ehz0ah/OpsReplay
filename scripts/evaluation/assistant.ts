import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ChatProvider, type AssistantProvider } from '../../apps/api/src/assistant/provider.js';
import type { AssistantContext } from '../../apps/api/src/assistant/context.js';
import { distribution, exact, integer, reserveReport } from './report.js';
export interface BenchmarkCase {
  id: string;
  context: AssistantContext;
  question: string;
  rubric: string[];
  forbiddenText: string[];
}
export interface AssistantConfiguration {
  endpoint: string;
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  maxEstimatedUsd: number;
  repeats: number;
}
export function assistantConfiguration(input: unknown): AssistantConfiguration {
  exact(input, ['endpoint', 'model', 'inputUsdPerMillion', 'outputUsdPerMillion', 'maxEstimatedUsd', 'repeats']);
  for (const name of ['inputUsdPerMillion', 'outputUsdPerMillion', 'maxEstimatedUsd'])
    if (typeof input[name] !== 'number' || !Number.isFinite(input[name]) || input[name] <= 0)
      throw new Error('Provide positive published prices and budget.');
  integer(input.repeats, 1, 3);
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 100)
    throw new Error('Specify model.');
  return input as unknown as AssistantConfiguration;
}
export async function benchmarkAssistant(
  config: AssistantConfiguration,
  cases: BenchmarkCase[],
  output: string,
  provider?: AssistantProvider,
) {
  if (
    !Array.isArray(cases) ||
    cases.length < 1 ||
    cases.length > 20 ||
    new Set(cases.map((v) => v.id)).size !== cases.length
  )
    throw new Error('Invalid labelled case set.');
  for (const item of cases) {
    if (
      !item.id ||
      !item.question ||
      item.question.length > 4000 ||
      !item.rubric.length ||
      !Array.isArray(item.forbiddenText) ||
      item.forbiddenText.some((v) => !v)
    )
      throw new Error('Invalid labelled case.');
  }
  const client =
    provider ??
    new ChatProvider({
      endpoint: config.endpoint,
      model: config.model,
      key: async () => {
        const key = process.env.OPSREPLAY_EVAL_PROVIDER_KEY;
        if (!key) throw new Error('Provider key is required.');
        return key;
      },
      maximumOutputTokens: 1200,
    });
  const results = [];
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const write = await reserveReport(output);
  let estimatedUsd = 0,
    stopped: string | null = null;
  for (let repeat = 1; repeat <= config.repeats && !stopped; repeat++)
    for (const item of cases) {
      // Conservative local reservation, not a provider billing guarantee.
      const inputTokenReserve = Buffer.byteLength(JSON.stringify(item.context) + item.question) + 4096;
      const reserve = (inputTokenReserve * config.inputUsdPerMillion + 1200 * config.outputUsdPerMillion) / 1_000_000;
      if (estimatedUsd + reserve > config.maxEstimatedUsd) {
        stopped = 'estimated_budget';
        break;
      }
      const started = performance.now();
      const timing: { firstDeltaMs: number | null } = { firstDeltaMs: null };
      try {
        const result = await client.reply(
          item.context,
          [],
          item.question,
          (text) => {
            if (text.trim().length) timing.firstDeltaMs ??= performance.now() - started;
          },
          AbortSignal.timeout(45000),
        );
        if (
          !Number.isSafeInteger(result.usage.inputTokens) ||
          result.usage.inputTokens <= 0 ||
          !Number.isSafeInteger(result.usage.outputTokens) ||
          result.usage.outputTokens <= 0
        ) {
          stopped = 'usage_missing';
          estimatedUsd += reserve;
          results.push({
            id: item.id,
            repeat,
            status: 'usage_missing',
            durationMs: performance.now() - started,
            firstDeltaMs: timing.firstDeltaMs,
            estimatedUsd: reserve,
            costBasis: 'reservation',
          });
          break;
        }
        const cost =
          (result.usage.inputTokens * config.inputUsdPerMillion +
            result.usage.outputTokens * config.outputUsdPerMillion) /
          1_000_000;
        estimatedUsd += cost;
        const text = result.text + '\n' + (result.proposal?.command ?? '');
        results.push({
          id: item.id,
          repeat,
          status: 'completed',
          durationMs: performance.now() - started,
          firstDeltaMs: timing.firstDeltaMs,
          usage: result.usage,
          estimatedUsd: cost,
          costBasis: 'reported_usage',
          text: result.text,
          proposal: result.proposal ?? null,
          forbiddenTextMatches: item.forbiddenText.filter((v) => text.toLowerCase().includes(v.toLowerCase())),
          rubric: item.rubric,
          review: {
            commandRelevant: null,
            teachingAccurate: null,
            unsupportedFacts: null,
            answerLeakage: null,
            destructiveSuggestion: null,
          },
        });
        if (estimatedUsd > config.maxEstimatedUsd) {
          stopped = 'estimated_budget';
          break;
        }
      } catch {
        estimatedUsd += reserve;
        stopped = 'provider_failure';
        results.push({
          id: item.id,
          repeat,
          status: 'failed',
          durationMs: performance.now() - started,
          firstDeltaMs: timing.firstDeltaMs,
          estimatedUsd: reserve,
          costBasis: 'reservation',
        });
        break;
      }
    }
  const completed = results.filter((result) => result.status === 'completed');
  const providerFailures = results.filter((result) => result.status === 'failed').length;
  const usageMissing = results.filter((result) => result.status === 'usage_missing').length;
  const plannedAttempts = cases.length * config.repeats;
  await write({
    schemaVersion: 1,
    kind: 'assistant-labelled-benchmark',
    revision,
    casesSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
    model: config.model,
    repeats: config.repeats,
    prices: { inputUsdPerMillion: config.inputUsdPerMillion, outputUsdPerMillion: config.outputUsdPerMillion },
    estimatedUsd,
    maxEstimatedUsd: config.maxEstimatedUsd,
    stopped,
    summary: {
      plannedAttempts,
      attempted: results.length,
      completed: completed.length,
      providerFailures,
      usageMissing,
      notAttempted: plannedAttempts - results.length,
      providerFailureRate: results.length ? providerFailures / results.length : null,
      incompleteRate: results.length ? (results.length - completed.length) / results.length : null,
    },
    costAccounting: {
      reportedUsageUsd: completed.reduce((sum, result) => sum + result.estimatedUsd, 0),
      reservedUsd: results
        .filter((result) => result.costBasis === 'reservation')
        .reduce((sum, result) => sum + result.estimatedUsd, 0),
    },
    durationMs: distribution(results.map((r) => r.durationMs)),
    completedDurationMs: distribution(completed.map((result) => result.durationMs)),
    firstDeltaMs: distribution(
      completed.map((result) => result.firstDeltaMs).filter((value): value is number => value !== null),
    ),
    results,
    limits: [
      'Uses the production provider adapter with synthetic visible context. Not the deployed API round trip.',
      'Lexical flags are review aids, not an accuracy or leakage score.',
      'Reviewer must score every completed response against its rubric.',
      'Provider-enforced spend cap is required for a hard budget. Local prices and token reservations are estimates.',
    ],
  });
  return stopped === null;
}
