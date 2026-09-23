import { describe, expect, it } from 'vitest';
import type { Command } from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };
import traces from '../../../tests/fixtures/reference-traces.json' with { type: 'json' };
import { compileScenario } from './definition.js';
import { end, project, start, step } from './engine.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const compiled = compileScenario(scenario);
const rollback: Command = {
  tool: 'rollback_deployment',
  arguments: { service: 'checkout-api', targetVersion: '2.6.0' },
};

describe('engine', () => {
  it.each(traces.paths)('matches the independently authored $id trace', (trace) => {
    let state = start(compiled, id).state;
    for (const command of trace.commands)
      state = step(compiled, state, command, state.version).state;
    expect({
      tick: state.tick,
      status: state.status,
      impactUnits: state.costs.impactUnits,
      variables: state.variables,
    }).toEqual(trace.expected);
    expect(validatePublic('SessionView', project(compiled, state)).ok).toBe(true);
  });

  it('reproduces every state and logical event for the same ordered actions', () => {
    const execute = () => {
      const initial = start(compiled, id);
      const first = step(
        compiled,
        initial.state,
        {
          tool: 'get_metric',
          arguments: { service: 'database', metric: 'connections', windowTicks: 10 },
        },
        0,
      );
      const second = step(compiled, first.state, rollback, 1);
      return [initial, first, second];
    };
    expect(execute()).toEqual(execute());
  });

  it.each([
    ['unknown service', { tool: 'restart_service', arguments: { service: 'hidden-service' } }, 0],
    [
      'invalid schema',
      { tool: 'scale_service', arguments: { service: 'checkout-api', instances: '6' } },
      0,
    ],
    ['stale version', rollback, 4],
    ['missing evidence', { tool: 'inspect_diff', arguments: { deploymentId: 'deploy-2-6-1' } }, 0],
  ])('rejects %s without changing any state', (_, command, version) => {
    const initial = start(compiled, id).state;
    const before = structuredClone(initial);
    expect(() => step(compiled, initial, command, version)).toThrow();
    expect(initial).toEqual(before);
  });

  it('uses failure priority and stops at the first terminal tick', () => {
    const both = compileScenario({
      ...scenario,
      failure: { literal: true },
      resolution: { literal: true },
    });
    const result = step(
      both,
      start(both, id).state,
      { tool: 'advance_time', arguments: { ticks: 10 } },
      0,
    );
    expect(result.state.status).toBe('failed');
    expect(result.state.tick).toBe(1);
    expect(result.state.version).toBe(1);
  });

  it('returns requested evidence even when its time cost ends the incident', () => {
    const failing = compileScenario({ ...scenario, failure: { literal: true } });
    const result = step(
      failing,
      start(failing, id).state,
      {
        tool: 'get_metric',
        arguments: { service: 'database', metric: 'connections', windowTicks: 1 },
      },
      0,
    );
    expect(result.state.status).toBe('failed');
    expect(result.output.evidence[0]?.id).toBe('db-connections');
    expect(result.state.costs.investigationTicks).toBe(1);
  });

  it('ends an attempt without advancing time and prevents further commands', () => {
    const initial = start(compiled, id).state;
    const result = end(compiled, initial, 0);
    expect(result.state.tick).toBe(0);
    expect(result.state.version).toBe(1);
    expect(result.state.status).toBe('ended');
    expect(initial.status).toBe('active');
    expect(() => step(compiled, result.state, rollback, 1)).toThrow(/ended/);
  });

  it('does not offer a diff when the deployment query returned no matching deployments', () => {
    const result = step(
      compiled,
      start(compiled, id).state,
      { tool: 'list_deployments', arguments: { service: 'checkout-api', windowTicks: 1 } },
      0,
    );
    expect(
      project(compiled, result.state).availableOperations.some(
        (offer) => offer.tool === 'inspect_diff',
      ),
    ).toBe(false);
  });

  it('keeps hidden variables, answers, and metric definitions outside public projections', () => {
    const view = project(compiled, start(compiled, id).state);
    expect(Object.keys(view)).not.toContain('variables');
    expect(JSON.stringify(view)).not.toContain(scenario.debrief.rootCause);
    expect(view.visibleMetrics.map((metric) => metric.metric)).toEqual(['error_percent']);
    expect(view.revealedEvidence.map((item) => item.id)).toEqual(['checkout-alert']);
  });
});
