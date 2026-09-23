import { describe, expect, it } from 'vitest';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };
import { compileScenario } from './definition.js';
import { project, start, step } from './engine.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const compiled = compileScenario(scenario);

describe('evidence observations', () => {
  it('includes both metric window endpoints and preserves earlier observations', () => {
    const command = {
      tool: 'get_metric',
      arguments: { service: 'database', metric: 'connections', windowTicks: 1 },
    };
    const first = step(compiled, start(compiled, id).state, command, 0);
    const saved = structuredClone(first.output.evidence);
    const second = step(compiled, first.state, command, 1);
    const observation = first.output.evidence[0];
    expect(observation?.kind).toBe('metric');
    if (observation?.kind !== 'metric') throw new Error('Expected metric');
    expect(observation.data.samples).toEqual([
      { tick: 0, value: 90 },
      { tick: 1, value: 102 },
    ]);
    expect(first.output.evidence).toEqual(saved);
    expect(second.output.evidence[0]?.observationId).not.toBe(observation.observationId);
    const before = structuredClone(second.state);
    project(compiled, second.state);
    expect(second.state).toEqual(before);
  });

  it('uses event occurrence time for logs and does not repeat a stable event', () => {
    const waited = step(
      compiled,
      start(compiled, id).state,
      { tool: 'advance_time', arguments: { ticks: 2 } },
      0,
    );
    expect(
      waited.events.filter(
        (event) => event.message === 'Database connection demand exceeds capacity.',
      ),
    ).toHaveLength(1);
    const result = step(
      compiled,
      waited.state,
      {
        tool: 'query_logs',
        arguments: {
          service: 'checkout-api',
          windowTicks: 10,
          severity: 'error',
          contains: 'CONNECTION',
        },
      },
      1,
    );
    const logs = result.output.evidence[0];
    if (logs?.kind !== 'logs') throw new Error('Expected logs');
    expect(logs.data.entries).toEqual([
      {
        tick: 1,
        service: 'checkout-api',
        severity: 'error',
        message: 'Timed out waiting for a database connection',
      },
    ]);
  });

  it('excludes future deployments and uses authored diff paths', () => {
    const data = structuredClone(scenario);
    const deployment = data.evidence.find((item) => item.kind === 'deployments');
    const definitions = deployment?.data.deployments;
    if (!definitions) throw new Error('Expected deployment template');
    definitions.push({ id: 'future', version: '3', previousVersion: '2', tick: 8 });
    const future = compileScenario(data);
    const listed = step(
      future,
      start(future, id).state,
      { tool: 'list_deployments', arguments: { service: 'checkout-api', windowTicks: 10 } },
      0,
    );
    const evidence = listed.output.evidence[0];
    if (evidence?.kind !== 'deployments') throw new Error('Expected deployments');
    expect(evidence.data.deployments.map((item) => item.id)).toEqual(['deploy-2-6-1']);
    const diff = step(
      future,
      listed.state,
      { tool: 'inspect_diff', arguments: { deploymentId: 'deploy-2-6-1' } },
      1,
    ).output.evidence[0];
    if (diff?.kind !== 'diff') throw new Error('Expected diff');
    expect(diff.data.lines[0]?.file).toBe('checkout/database.ts');
    expect(diff.data.lines[0]?.text).toBe('connection = acquireConnection()');
  });

  it('limits status evidence to the selected metric', () => {
    const withPrivate = compileScenario({
      ...scenario,
      metrics: [
        ...scenario.metrics,
        {
          service: 'checkout-api',
          metric: 'private_metric',
          unit: 'count',
          alwaysVisible: false,
          expression: { literal: 99 },
        },
      ],
    });
    const status = step(
      withPrivate,
      start(withPrivate, id).state,
      { tool: 'get_service_status', arguments: { service: 'checkout-api' } },
      0,
    ).output.evidence[0];
    if (status?.kind !== 'status') throw new Error('Expected status');
    expect(status.data.metrics.map((metric) => metric.metric)).toEqual(['error_percent']);
  });
});
