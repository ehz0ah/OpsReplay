import { describe, expect, it } from 'vitest';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };
import { compileScenario } from './definition.js';
import { DefinitionError } from './errors.js';

describe('compileScenario', () => {
  it('compiles the reference scenario and isolates its immutable definition', () => {
    const input = structuredClone(scenario);
    const compiled = compileScenario(input);
    input.title = 'Caller changed title';
    expect(compiled.definition.title).toBe(scenario.title);
    expect(Object.isFrozen(compiled.definition.actions)).toBe(true);
    expect(compiled.actions).toHaveLength(12);
  });

  it.each([
    [
      'duplicate action',
      (value: typeof scenario) =>
        value.actions.push(structuredClone(value.actions[0]) as (typeof value.actions)[number]),
    ],
    ['missing evidence', (value: typeof scenario) => value.initialEvidence.push('missing')],
    [
      'invalid state',
      (value: typeof scenario) => {
        value.initialState.instances = 7;
      },
    ],
    [
      'out of bounds rule',
      (value: typeof scenario) => {
        Object.assign(value.tickRules[0] ?? {}, { value: { literal: 999 } });
      },
    ],
    [
      'unknown log event',
      (value: typeof scenario) => {
        const item = value.evidence.find((entry) => entry.kind === 'logs');
        Object.assign(item?.data ?? {}, {
          templates: [{ event: 'unknown', severity: 'error', message: 'Message' }],
        });
      },
    ],
    [
      'unattributed publication',
      (value: typeof scenario) => {
        value.status = 'published';
      },
    ],
    [
      'duplicate checkpoint trigger',
      (value: typeof scenario) => {
        Object.assign(value.checkpoints[1] ?? {}, { trigger: 'start' });
      },
    ],
  ])('rejects %s', (_, change) => {
    const input = structuredClone(scenario);
    change(input);
    expect(() => compileScenario(input)).toThrow(DefinitionError);
  });

  it('rejects impact bounds that can exceed the public cost limit', () => {
    expect(() => compileScenario({ ...scenario, impact: { literal: 200001 } })).toThrow(
      DefinitionError,
    );
  });

  it('rejects recursive input before calling the schema validator', () => {
    const cycle: Record<string, unknown> = { op: 'not' };
    cycle.args = [cycle];
    expect(() => compileScenario({ ...scenario, resolution: cycle })).toThrow(DefinitionError);
  });

  it.each([
    ['a different service', { service: 'payment-api', metric: 'connections' }, ['db-connections']],
    ['a different metric', { service: 'database', metric: 'cpu' }, ['db-connections']],
    ['an unbound target', { metric: 'connections' }, ['db-connections']],
    [
      'a different evidence kind',
      { service: 'database', metric: 'connections' },
      ['checkout-runbook'],
    ],
  ])('rejects metric actions that expose %s', (_, arguments_, reveals) => {
    const input = structuredClone(scenario);
    const metricAction = input.actions.find(
      (entry) => entry.tool === 'get_metric' && entry.arguments.service === 'database',
    );
    expect(metricAction).toBeDefined();
    Object.assign(metricAction ?? {}, { arguments: arguments_, reveals });
    expect(() => compileScenario(input)).toThrow(DefinitionError);
  });
});
