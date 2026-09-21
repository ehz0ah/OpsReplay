// Executable specification fixture, not the production engine.
// It covers the bounded reference rules. It has no persistence or HTTP behaviour.
import assert from 'node:assert/strict';

export function evaluate(expression, state, args = {}) {
  if ('literal' in expression) return expression.literal;
  if ('ref' in expression) {
    assert.ok(Object.hasOwn(state, expression.ref), 'Unknown state reference: ' + expression.ref);
    return state[expression.ref];
  }
  if ('arg' in expression) {
    assert.ok(Object.hasOwn(args, expression.arg), 'Unknown command argument: ' + expression.arg);
    return args[expression.arg];
  }
  const values = expression.args.map(item => evaluate(item, state, args));
  if (['add', 'sub', 'mul', 'min', 'max', 'gte', 'gt', 'lt'].includes(expression.op)) {
    assert.ok(values.every(Number.isSafeInteger), 'Arithmetic requires safe integers');
  }
  if (['and', 'or', 'not'].includes(expression.op)) {
    assert.ok(values.every(value => typeof value === 'boolean'), 'Boolean operator requires booleans');
  }
  let result;
  switch (expression.op) {
    case 'add': result = values.reduce((a, b) => a + b, 0); break;
    case 'sub': result = values[0] - values[1]; break;
    case 'mul': result = values.reduce((a, b) => a * b, 1); break;
    case 'min': result = Math.min(...values); break;
    case 'max': result = Math.max(...values); break;
    case 'eq': result = values[0] === values[1]; break;
    case 'gte': result = values[0] >= values[1]; break;
    case 'gt': result = values[0] > values[1]; break;
    case 'lt': result = values[0] < values[1]; break;
    case 'and': result = values.every(Boolean); break;
    case 'or': result = values.some(Boolean); break;
    case 'not': result = !values[0]; break;
    case 'if':
      assert.equal(typeof values[0], 'boolean');
      result = values[0] ? values[1] : values[2];
      break;
    default: throw new Error('Unknown operator: ' + expression.op);
  }
  if (typeof result === 'number') assert.ok(Number.isSafeInteger(result), 'Unsafe rule result');
  return result;
}

function checkVariables(definition, variables) {
  for (const [name, spec] of Object.entries(definition.variables)) {
    const value = variables[name];
    if (spec.type === 'boolean') assert.equal(typeof value, 'boolean');
    else {
      assert.ok(Number.isSafeInteger(value), 'Invalid integer: ' + name);
      assert.ok(value >= spec.minimum && value <= spec.maximum, 'Out of bounds: ' + name);
    }
  }
}

export function start(definition) {
  const state = {
    variables: structuredClone(definition.initialState), tick: 0, status: 'active',
    impactUnits: 0, investigationTicks: 0, revealed: [...definition.initialEvidence],
    flags: {}, events: [], samples: [],
  };
  checkVariables(definition, state.variables);
  const context = { ...state.variables, tick: state.tick };
  for (const rule of definition.eventRules) state.flags[rule.id] = evaluate(rule.when, context);
  state.samples.push({ tick: 0, metrics: metrics(definition, state) });
  return state;
}

export function metrics(definition, state) {
  return definition.metrics.map(metric => ({
    service: metric.service, metric: metric.metric, unit: metric.unit,
    value: evaluate(metric.expression, { ...state.variables, tick: state.tick }),
  }));
}

export function step(definition, input, command, registry) {
  assert.equal(input.status, 'active', 'Session is terminal');
  const state = structuredClone(input);
  const matches = definition.actions.filter(action => action.tool === command.tool
    && Object.entries(action.arguments).every(([key, value]) => command.arguments[key] === value));
  assert.equal(matches.length, 1, 'Action must match exactly one definition');
  const action = matches[0];
  assert.ok(action.requiresEvidence.every(id => state.revealed.includes(id)), 'Evidence prerequisite failed');
  assert.equal(evaluate(action.prerequisite, { ...state.variables, tick: state.tick }, command.arguments), true);
  for (const assignment of action.effects) {
    state.variables[assignment.target] = evaluate(assignment.value, { ...state.variables, tick: state.tick }, command.arguments);
    checkVariables(definition, state.variables);
  }
  const ticks = action.costFromArgument ? command.arguments[action.costFromArgument] : action.costTicks;
  assert.ok(Number.isInteger(ticks) && ticks >= 1 && ticks <= 10);
  state.events.push({ tick: state.tick, kind: 'action', action: action.id });
  const investigation = registry.tools.find(tool => tool.name === command.tool).kind === 'investigation';
  for (let count = 0; count < ticks; count++) {
    state.tick++;
    if (investigation) state.investigationTicks++;
    for (const rule of definition.tickRules) {
      state.variables[rule.target] = evaluate(rule.value, { ...state.variables, tick: state.tick });
      checkVariables(definition, state.variables);
    }
    const context = { ...state.variables, tick: state.tick };
    const impact = evaluate(definition.impact, context);
    assert.ok(Number.isSafeInteger(impact) && impact >= 0);
    state.impactUnits += impact;
    state.samples.push({ tick: state.tick, metrics: metrics(definition, state) });
    for (const rule of definition.eventRules) {
      const active = evaluate(rule.when, context);
      assert.equal(typeof active, 'boolean');
      if (active && !state.flags[rule.id]) state.events.push({ tick: state.tick, kind: 'incident', id: rule.id });
      state.flags[rule.id] = active;
    }
    if (evaluate(definition.failure, context)) state.status = 'failed';
    else if (evaluate(definition.resolution, context)) state.status = 'resolved';
    if (state.status !== 'active') break;
  }
  state.revealed = [...new Set([...state.revealed, ...action.reveals])];
  return state;
}
