import { describe, expect, it } from 'vitest';
import { createValidator, issuesFrom } from './validator.js';

describe('createValidator', () => {
  it('rejects invalid dates and non-finite JSON numbers', () => {
    const ajv = createValidator();
    const date = ajv.compile({ type: 'string', format: 'date-time' });
    expect(date('2026-02-30T00:00:00Z')).toBe(false);
    expect(date('2026-09-23T00:00:00Z')).toBe(true);
    const number = ajv.compile({ type: 'number' });
    expect(number(Infinity)).toBe(false);
    expect(number(NaN)).toBe(false);
  });

  it('requires own properties instead of values inherited from a prototype', () => {
    const validate = createValidator().compile({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    const inherited: unknown = Object.create({ id: 'not-an-own-property' });
    expect(validate(inherited)).toBe(false);
  });
});

describe('issuesFrom', () => {
  it('provides a safe fallback and omits schema parameters', () => {
    expect(
      issuesFrom([
        { instancePath: '/id', schemaPath: '#', keyword: 'format', params: { input: 'private' } },
      ]),
    ).toEqual([{ path: '/id', keyword: 'format', message: 'Invalid value' }]);
    expect(issuesFrom(undefined)).toEqual([]);
    expect(issuesFrom(null)).toEqual([]);
  });
});
