import { describe, expect, it } from 'vitest';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };
import { compileScenario } from './definition.js';
import { debrief } from './debrief.js';
import { end, start, step } from './engine.js';
import { validatePublic } from '@opsreplay/contracts/validation';

describe('debrief', () => {
  it('withholds answers during the attempt and releases authored feedback after it ends', () => {
    const compiled = compileScenario(scenario);
    const initial = start(compiled, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').state;
    expect(() => debrief(compiled, initial, [])).toThrow(/End the attempt/);
    const investigated = step(
      compiled,
      initial,
      {
        tool: 'get_metric',
        arguments: { service: 'database', metric: 'connections', windowTicks: 10 },
      },
      0,
    );
    const finished = end(compiled, investigated.state, 1).state;
    const result = debrief(compiled, finished, investigated.action ? [investigated.action] : []);
    expect(result.rootCause).toBe(scenario.debrief.rootCause);
    expect(result.foundEvidence).toContain('db-connections');
    expect(result.missedEvidence).toContain('checkout-diff');
    expect(result.actionFeedback.join(' ')).toContain('impact 70 units');
    expect(validatePublic('Debrief', result).ok).toBe(true);
  });
});
