import { describe, expect, it } from 'vitest';
import request from '../examples/action-request.json' with { type: 'json' };
import session from '../examples/session.json' with { type: 'json' };
import { validatePublic } from './validation.js';

describe('validatePublic', () => {
  it('accepts an action and narrows its command without changing the input', () => {
    const input = structuredClone(request);
    const result = validatePublic('ActionRequest', input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a valid action');
    expect(result.value).toBe(input);
    expect(input).toEqual(request);
  });

  it.each([
    ['unknown tool', { tool: 'get_root_cause', arguments: {} }],
    [
      'string count',
      { tool: 'scale_service', arguments: { service: 'checkout-api', instances: '6' } },
    ],
    [
      'fractional count',
      { tool: 'scale_service', arguments: { service: 'checkout-api', instances: 2.5 } },
    ],
    [
      'extra parameter',
      { tool: 'restart_service', arguments: { service: 'checkout-api', force: true } },
    ],
    ['missing parameter', { tool: 'get_metric', arguments: { service: 'checkout-api' } }],
  ])('rejects %s without coercion or removal', (_, command) => {
    const input = { ...request, command };
    const before = structuredClone(input);
    expect(validatePublic('ActionRequest', input).ok).toBe(false);
    expect(input).toEqual(before);
  });

  it('rejects malformed request IDs and untrusted LLM execution sources', () => {
    expect(validatePublic('ActionRequest', { ...request, requestId: 'not-a-uuid' }).ok).toBe(false);
    expect(validatePublic('ActionRequest', { ...request, source: 'llm_tool' }).ok).toBe(false);
  });

  it('rejects private fields at the session and nested evidence boundaries', () => {
    expect(validatePublic('SessionView', session).ok).toBe(true);
    expect(validatePublic('SessionView', { ...session, rootCause: 'secret' }).ok).toBe(false);
    const leaked = structuredClone(session);
    const first = leaked.revealedEvidence[0];
    if (!first) throw new Error('Fixture must have evidence');
    Object.assign(first.data, { rootCause: 'secret' });
    expect(validatePublic('SessionView', leaked).ok).toBe(false);
  });

  it('retains error details after a later validation and omits input data', () => {
    const failed = validatePublic('ActionRequest', { ...request, requestId: 'sensitive-input' });
    if (failed.ok) throw new Error('Expected a rejected request');
    const saved = structuredClone(failed.issues);
    validatePublic('ActionRequest', request);
    expect(failed.issues).toEqual(saved);
    expect(failed.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed.issues)).not.toContain('sensitive-input');
  });
});
