import type { Command, Evidence } from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';
import type { CompiledScenario, EvidenceDefinition } from './definition.js';
import { requireDefinition } from './errors.js';
import { currentMetrics } from './state.js';
import type { EngineState } from './state.js';

export function observe(
  scenario: CompiledScenario,
  state: EngineState,
  item: EvidenceDefinition,
  command?: Command,
): Evidence {
  const base = {
    id: item.id,
    title: item.title,
    observationId: `${state.id}:${state.version}:${item.id}`,
    observedTick: state.tick,
    observedVersion: state.version,
  };
  const args: Record<string, unknown> = command?.arguments ?? {};
  const windowTicks = typeof args.windowTicks === 'number' ? args.windowTicks : 10;
  const from = state.tick - windowTicks;
  const metrics = currentMetrics(scenario, state);
  let result: Evidence;
  switch (item.kind) {
    case 'alert':
    case 'diff':
    case 'runbook':
    case 'architecture':
      result = { ...base, ...item };
      break;
    case 'metric': {
      const metric = metrics.find(
        (value) => value.service === item.data.service && value.metric === item.data.metric,
      );
      requireDefinition(metric, `Missing metric: ${item.id}`);
      result = {
        ...base,
        kind: 'metric',
        data: {
          service: metric.service,
          metric: metric.metric,
          unit: metric.unit,
          samples: state.samples
            .filter((sample) => sample.tick >= from && sample.tick <= state.tick)
            .map((sample) => {
              const value = sample.metrics.find(
                (entry) => entry.service === metric.service && entry.metric === metric.metric,
              );
              requireDefinition(value, 'Missing metric sample');
              return { tick: sample.tick, value: value.value };
            }),
        },
      };
      break;
    }
    case 'status':
      result = {
        ...base,
        kind: 'status',
        data: {
          service: item.data.service,
          metrics: metrics.filter(
            (value) => value.service === item.data.service && value.metric === item.data.metric,
          ),
        },
      };
      break;
    case 'logs':
      result = {
        ...base,
        kind: 'logs',
        data: {
          service: item.data.service,
          entries: state.occurrences
            .filter((entry) => entry.tick >= from && entry.tick <= state.tick)
            .flatMap((entry) =>
              item.data.templates
                .filter((template) => template.event === entry.ruleId)
                .map((template) => ({
                  tick: entry.tick,
                  service: item.data.service,
                  severity: template.severity,
                  message: template.message,
                })),
            )
            .filter(
              (entry) =>
                (!args.severity || args.severity === entry.severity) &&
                (typeof args.contains !== 'string' ||
                  entry.message.toLowerCase().includes(args.contains.toLowerCase())),
            ),
        },
      };
      break;
    case 'deployments':
      result = {
        ...base,
        kind: 'deployments',
        data: {
          service: item.data.service,
          deployments: item.data.deployments.filter(
            (entry) => entry.tick >= from && entry.tick <= state.tick,
          ),
        },
      };
      break;
  }
  requireDefinition(validatePublic('Evidence', result).ok, `Invalid evidence output: ${item.id}`);
  return structuredClone(result);
}

export function reveal(
  scenario: CompiledScenario,
  state: EngineState,
  ids: string[],
  command?: Command,
): Evidence[] {
  const observations = ids.map((id) => {
    const template = scenario.definition.evidence.find((item) => item.id === id);
    requireDefinition(template, `Unknown evidence: ${id}`);
    return observe(scenario, state, template, command);
  });
  const replaced = new Set(ids);
  state.evidence = [...state.evidence.filter((item) => !replaced.has(item.id)), ...observations];
  return observations;
}
