import { describe, expect, it } from 'vitest';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };
import { compileScenario } from './definition.js';
import { compare } from './debrief.js';
import { end, start, step } from './engine.js';
import { replay } from './replay.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rollback = {
  tool: 'rollback_deployment',
  arguments: { service: 'checkout-api', targetVersion: '2.6.0' },
};

describe('replay', () => {
  it('captures the authored checkpoint before the first mitigation and never overwrites it', () => {
    const data = structuredClone(scenario);
    const checkpoint = data.checkpoints[1];
    if (!checkpoint) throw new Error('Expected checkpoint');
    checkpoint.id = 'decision-one';
    const compiled = compileScenario(data);
    const initial = start(compiled, id).state;
    const investigated = step(
      compiled,
      initial,
      {
        tool: 'get_metric',
        arguments: { service: 'database', metric: 'connections', windowTicks: 10 },
      },
      0,
    ).state;
    const restarted = step(
      compiled,
      investigated,
      { tool: 'restart_service', arguments: { service: 'checkout-api' } },
      1,
    ).state;
    const finished = step(compiled, restarted, rollback, 2).state;
    const saved = finished.checkpoints.find((item) => item.id === 'decision-one');
    expect(saved?.snapshot.tick).toBe(1);
    expect(saved?.snapshot.variables).toEqual(investigated.variables);
    expect(saved?.snapshot.nextSequence).toBe(investigated.nextSequence);
    const original = structuredClone(finished);
    const child = replay(finished, 'decision-one', childId).state;
    expect(child.version).toBe(0);
    expect(child.costs).toEqual(investigated.costs);
    expect(child.eventFlags).toEqual(investigated.eventFlags);
    expect(child.evidence).toEqual(investigated.evidence);
    expect(child.informedPractice).toBe(true);
    const alternate = step(compiled, child, rollback, 0).state;
    expect(finished).toEqual(original);
    const comparison = compare(finished, alternate);
    expect(comparison.checkpointTick).toBe(1);
    expect(comparison.replay.observedTicks).toBe(alternate.tick - 1);
    expect(comparison.replay.impactUnits).toBe(
      alternate.costs.impactUnits - investigated.costs.impactUnits,
    );
  });

  it('requires a terminal original and rejects replay of a replay', () => {
    const compiled = compileScenario(scenario);
    const initial = start(compiled, id).state;
    expect(() => replay(initial, 'start', childId)).toThrow();
    const ended = end(compiled, initial, 0).state;
    const child = replay(ended, 'start', childId).state;
    expect(() => replay(end(compiled, child, 0).state, 'start', id)).toThrow();
    expect(() => replay(ended, 'missing', childId)).toThrow();
    expect(compare(ended, child).original.recoveryTicks).toBe(null);
    expect(() => compare({ ...ended, id: 'unrelated' }, child)).toThrow();
  });
});
