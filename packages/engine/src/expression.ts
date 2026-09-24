import type { Expression } from '@opsreplay/contracts/scenario';
import { DefinitionError, requireDefinition } from './errors.js';

export type Scalar = number | boolean | string;
export type ValueType =
  { type: 'integer'; minimum: number; maximum: number } | { type: 'boolean' } | { type: 'string' };
export interface ExpressionContext {
  state: Readonly<Record<string, number | boolean>>;
  tick: number;
  arguments: Readonly<Record<string, unknown>>;
}
export interface CompiledExpression {
  result: ValueType;
  usesArguments: boolean;
  evaluate: (context: ExpressionContext) => Scalar;
}
export interface ExpressionTypes {
  state: Readonly<Record<string, ValueType>>;
  arguments: Readonly<Record<string, ValueType>>;
}

export const MAX_TICK = 5000;

function safe(value: number): number {
  requireDefinition(Number.isSafeInteger(value), 'Expression arithmetic exceeds safe integers');
  return value;
}

function range(minimum: number, maximum = minimum): ValueType & { type: 'integer' } {
  return { type: 'integer', minimum: safe(minimum), maximum: safe(maximum) };
}

export function scalarType(value: Scalar): ValueType {
  return typeof value === 'number'
    ? range(value)
    : { type: typeof value === 'boolean' ? 'boolean' : 'string' };
}

function integer(value: Scalar): number {
  requireDefinition(typeof value === 'number', 'Expected integer operand');
  return safe(value);
}

function boolean(value: Scalar): boolean {
  requireDefinition(typeof value === 'boolean', 'Expected boolean operand');
  return value;
}

export function compileExpression(
  expression: Expression,
  types: ExpressionTypes,
): CompiledExpression {
  let nodes = 0;
  const visit = (node: Expression, depth: number): CompiledExpression => {
    requireDefinition(depth <= 20 && ++nodes <= 200, 'Expression exceeds depth or node limit');
    if ('literal' in node) {
      return {
        result: scalarType(node.literal),
        usesArguments: false,
        evaluate: () => node.literal,
      };
    }
    if ('ref' in node || 'arg' in node) {
      const isArgument = 'arg' in node;
      const key = isArgument ? node.arg : node.ref;
      const source = isArgument ? types.arguments : types.state;
      const result =
        !isArgument && key === 'tick'
          ? range(0, MAX_TICK)
          : Object.hasOwn(source, key)
            ? source[key]
            : undefined;
      requireDefinition(result, `Unknown ${isArgument ? 'argument' : 'state reference'}: ${key}`);
      return {
        result,
        usesArguments: isArgument,
        evaluate: (context) => {
          const value = isArgument
            ? context.arguments[key]
            : key === 'tick'
              ? context.tick
              : context.state[key];
          requireDefinition(
            result.type === 'integer'
              ? typeof value === 'number' &&
                  Number.isSafeInteger(value) &&
                  value >= result.minimum &&
                  value <= result.maximum
              : typeof value === result.type,
            `Invalid expression value: ${key}`,
          );
          return value as Scalar;
        },
      };
    }
    const fixed: Partial<Record<typeof node.op, number>> = {
      sub: 2,
      eq: 2,
      gte: 2,
      gt: 2,
      lt: 2,
      not: 1,
      if: 3,
    };
    const arity = fixed[node.op];
    requireDefinition(
      arity === undefined ? node.args.length >= 2 : node.args.length === arity,
      `Invalid arity: ${node.op}`,
    );
    const children = node.args.map((child) => visit(child, depth + 1));
    const at = (index: number) => {
      const child = children[index];
      requireDefinition(child, 'Missing operand');
      return child;
    };
    const usesArguments = children.some((child) => child.usesArguments);
    const operandTypes = children.map((child) => child.result.type);
    const requireTypes = (type: ValueType['type']) =>
      requireDefinition(
        operandTypes.every((value) => value === type),
        `Expected ${type} operands for ${node.op}`,
      );
    const numbers = () =>
      children.map((child) => {
        requireDefinition(child.result.type === 'integer', 'Expected integer bounds');
        return child.result;
      });
    let result: ValueType;
    let evaluate: CompiledExpression['evaluate'];
    switch (node.op) {
      case 'if': {
        requireDefinition(at(0).result.type === 'boolean', 'if condition must be boolean');
        const yes = at(1).result,
          no = at(2).result;
        requireDefinition(yes.type === no.type, 'if branches must have matching types');
        result =
          yes.type === 'integer' && no.type === 'integer'
            ? range(Math.min(yes.minimum, no.minimum), Math.max(yes.maximum, no.maximum))
            : yes;
        evaluate = (context) => at(boolean(at(0).evaluate(context)) ? 1 : 2).evaluate(context);
        break;
      }
      case 'eq':
        requireDefinition(
          at(0).result.type === at(1).result.type,
          'eq operands must have matching types',
        );
        result = { type: 'boolean' };
        evaluate = (context) => at(0).evaluate(context) === at(1).evaluate(context);
        break;
      case 'and':
      case 'or':
      case 'not': {
        requireTypes('boolean');
        result = { type: 'boolean' };
        evaluate = (context) => {
          const values = children.map((child) => boolean(child.evaluate(context)));
          return node.op === 'not'
            ? !values[0]
            : node.op === 'and'
              ? values.every(Boolean)
              : values.some(Boolean);
        };
        break;
      }
      case 'gte':
      case 'gt':
      case 'lt':
        requireTypes('integer');
        result = { type: 'boolean' };
        evaluate = (context) => {
          const left = integer(at(0).evaluate(context)),
            right = integer(at(1).evaluate(context));
          return node.op === 'gte' ? left >= right : node.op === 'gt' ? left > right : left < right;
        };
        break;
      case 'add':
      case 'sub':
      case 'mul':
      case 'min':
      case 'max': {
        requireTypes('integer');
        const bounds = numbers();
        const first = at(0).result,
          second = at(1).result;
        requireDefinition(
          first.type === 'integer' && second.type === 'integer',
          'Expected number operands',
        );
        switch (node.op) {
          case 'add':
            result = bounds.reduce(
              (sum, item) => range(sum.minimum + item.minimum, sum.maximum + item.maximum),
              range(0),
            );
            break;
          case 'sub':
            result = range(first.minimum - second.maximum, first.maximum - second.minimum);
            break;
          case 'mul':
            result = bounds.reduce((product, item) => {
              const ends = [
                product.minimum * item.minimum,
                product.minimum * item.maximum,
                product.maximum * item.minimum,
                product.maximum * item.maximum,
              ];
              return range(Math.min(...ends), Math.max(...ends));
            }, range(1));
            break;
          case 'min':
            result = range(
              Math.min(...bounds.map((item) => item.minimum)),
              Math.min(...bounds.map((item) => item.maximum)),
            );
            break;
          case 'max':
            result = range(
              Math.max(...bounds.map((item) => item.minimum)),
              Math.max(...bounds.map((item) => item.maximum)),
            );
            break;
        }
        evaluate = (context) => {
          const values = children.map((child) => integer(child.evaluate(context)));
          // node.op is narrowed by the surrounding arithmetic branch.
          // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
          switch (node.op) {
            case 'add':
              return values.reduce((sum, value) => safe(sum + value), 0);
            case 'sub':
              return safe(integer(at(0).evaluate(context)) - integer(at(1).evaluate(context)));
            case 'mul':
              return values.reduce((product, value) => safe(product * value), 1);
            case 'min':
              return Math.min(...values);
            case 'max':
              return Math.max(...values);
            default:
              throw new DefinitionError('Invalid arithmetic operator');
          }
        };
        break;
      }
    }
    return { result, usesArguments, evaluate };
  };
  return visit(expression, 0);
}

export function checkAssignable(actual: ValueType, expected: ValueType, label: string): void {
  requireDefinition(actual.type === expected.type, `Type mismatch: ${label}`);
  if (actual.type === 'integer' && expected.type === 'integer') {
    requireDefinition(
      actual.minimum >= expected.minimum && actual.maximum <= expected.maximum,
      `Unbounded assignment: ${label}`,
    );
  }
}
