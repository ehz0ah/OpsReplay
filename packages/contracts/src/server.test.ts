import { describe, expect, it } from 'vitest';
import scenario from '../../../content/challenges/checkout-connection-leak/scenario.json' with { type: 'json' };
import { getTool, validateScenarioShape } from './server.js';

describe('validateScenarioShape', () => {
  it('accepts the reference definition without changing it', () => {
    const input = structuredClone(scenario);
    const result = validateScenarioShape(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid scenario');
    expect(result.value).toBe(input);
    expect(input).toEqual(scenario);
  });

  it.each([
    ['unsupported schema version', { ...scenario, schemaVersion: '99.0.0' }],
    ['missing debrief', { ...scenario, debrief: undefined }],
    ['executable rule', { ...scenario, resolution: { script: 'return true' } }],
    ['unknown operator', { ...scenario, impact: { op: 'eval', args: [] } }],
  ])('rejects %s', (_, value) => {
    expect(validateScenarioShape(value).ok).toBe(false);
  });
});

describe('getTool', () => {
  it('returns independent tool definitions so callers cannot alter later sessions', () => {
    const original = getTool('scale_service');
    const copy = getTool('scale_service');
    copy.description = 'changed by caller';
    copy.inputSchema.required.length = 0;
    expect(getTool('scale_service')).toEqual(original);
    expect(original.kind).toBe('mitigation');
    expect(original.requiresConfirmation).toBe(true);
  });
});
