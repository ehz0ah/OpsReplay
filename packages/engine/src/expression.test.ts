import { describe, expect, it } from 'vitest';
import type { Expression } from '@opsreplay/contracts/scenario';
import { checkAssignable, compileExpression } from './expression.js';

const types = {
  state: {
    count: { type: 'integer' as const, minimum: 0, maximum: 10 },
    enabled: { type: 'boolean' as const },
  },
  arguments: { limit: { type: 'integer' as const, minimum: 1, maximum: 5 } },
};
const context = { state: { count: 3, enabled: true }, tick: 2, arguments: { limit: 4 } };
const literal = (value: number | boolean | string): Expression => ({ literal: value });

describe('compileExpression', () => {
  it.each([
    ['add', [3, 4], 7],
    ['sub', [3, 4], -1],
    ['mul', [3, 4], 12],
    ['min', [3, 4], 3],
    ['max', [3, 4], 4],
    ['eq', ['v1', 'v1'], true],
    ['gte', [4, 4], true],
    ['gt', [3, 4], false],
    ['lt', [3, 4], true],
    ['and', [true, false], false],
    ['or', [true, false], true],
    ['not', [false], true],
    ['if', [true, 3, 4], 3],
  ] as const)('evaluates %s with strict types', (op, values, expected) => {
    expect(compileExpression({ op, args: values.map(literal) }, types).evaluate(context)).toBe(
      expected,
    );
  });

  it('resolves state, tick and argument values and calculates conservative bounds', () => {
    const expression = compileExpression(
      { op: 'add', args: [{ ref: 'count' }, { arg: 'limit' }] },
      types,
    );
    expect(expression.result).toEqual({ type: 'integer', minimum: 1, maximum: 15 });
    expect(expression.evaluate(context)).toBe(7);
    expect(compileExpression({ ref: 'tick' }, types).evaluate(context)).toBe(2);
    expect(expression.usesArguments).toBe(true);
  });

  it.each([
    { ref: 'missing' },
    { arg: 'missing' },
    { op: 'not', args: [literal(true), literal(false)] },
    { op: 'add', args: [literal('1'), literal(1)] },
    { op: 'if', args: [literal(true), literal(1), { ref: 'missing' }] },
    { op: 'if', args: [literal(true), literal(1), literal(false)] },
    { op: 'add', args: [literal(Number.MAX_SAFE_INTEGER), literal(1)] },
  ] satisfies Expression[])('rejects invalid expressions before evaluation', (expression) => {
    expect(() => compileExpression(expression, types)).toThrow();
  });

  it('enforces complexity limits and assignment bounds', () => {
    let nested = literal(true);
    for (let i = 0; i < 22; i++) nested = { op: 'not', args: [nested] };
    expect(() => compileExpression(nested, types)).toThrow(/limit/);
    const wide: Expression = {
      op: 'and',
      args: Array.from({ length: 20 }, () => ({
        op: 'and',
        args: Array.from({ length: 20 }, () => literal(true)),
      })),
    };
    expect(() => compileExpression(wide, types)).toThrow(/limit/);
    expect(() =>
      checkAssignable({ type: 'integer', minimum: -1, maximum: 10 }, types.state.count, 'count'),
    ).toThrow(/Unbounded/);
    expect(() => checkAssignable({ type: 'boolean' }, types.state.count, 'count')).toThrow(/Type/);
  });
});
