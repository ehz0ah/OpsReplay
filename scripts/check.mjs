import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import SwaggerParser from '@apidevtools/swagger-parser';
import { start, step, metrics } from './reference-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const publicSchema = read('packages/contracts/schemas/public.schema.json');
const scenarioSchema = read('packages/contracts/schemas/scenario.schema.json');
ajv.addSchema(publicSchema);
const validateScenario = ajv.compile(scenarioSchema);
const registry = read('packages/contracts/tools.json');
const toolSchemas = new Map(registry.tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
assert.equal(toolSchemas.size, registry.tools.length, 'Duplicate tool name');

function valid(validate, value, label) {
  assert.ok(validate(value), label + ': ' + JSON.stringify(validate.errors));
}
const validateType = name => ajv.getSchema(publicSchema.$id + '#/$defs/' + name);
for (const name of Object.keys(publicSchema.$defs)) assert.ok(validateType(name), 'Uncompiled public schema ' + name);
for (const [file, type] of [
  ['session.json', 'SessionView'], ['action-request.json', 'ActionRequest'],
  ['action-response.json', 'ActionResponse'], ['catalog.json', 'Catalog'],
]) valid(validateType(type), read('packages/contracts/examples/' + file), file);
assert.equal(validateType('ActionRequest')(read('packages/contracts/examples/invalid-action.json')), false, 'Invalid scale accepted');
const leakingView = { ...read('packages/contracts/examples/session.json'), rootCause: 'hidden' };
assert.equal(validateType('SessionView')(leakingView), false, 'Private top-level field accepted');
const leakingEvidence = structuredClone(read('packages/contracts/examples/session.json'));
leakingEvidence.revealedEvidence[0].data.rootCause = 'hidden';
assert.equal(validateType('SessionView')(leakingEvidence), false, 'Private evidence field accepted');
for (const [name, value] of Object.entries(read('packages/contracts/examples/response-examples.json'))) {
  valid(validateType(name), value, name);
}

function rewrite(value) {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, key === '$ref' ? item.replace('#/$defs/', '#/components/schemas/') : rewrite(item),
  ]));
  return value;
}
const api = read('packages/contracts/openapi.json');
assert.deepEqual(api.components.schemas, rewrite(publicSchema.$defs), 'Run npm run contracts:sync after public schema changes');
await SwaggerParser.validate(path.join(root, 'packages/contracts/openapi.json'));
const apiDoc = fs.readFileSync(path.join(root, 'docs/api.md'), 'utf8');
for (const [route, methods] of Object.entries(api.paths)) {
  for (const method of Object.keys(methods)) {
    assert.ok(apiDoc.includes(method.toUpperCase() + ' ' + route), 'Undocumented route: ' + method + ' ' + route);
  }
}
for (const tool of registry.tools) {
  const branch = publicSchema.$defs.Command.oneOf.find(value => value.properties.tool.const === tool.name);
  assert.ok(branch, 'Missing command schema: ' + tool.name);
  assert.deepEqual(branch.properties.arguments, tool.inputSchema, 'Argument schema drift: ' + tool.name);
}

const definition = read('content/challenges/checkout-connection-leak/scenario.json');
valid(validateScenario, definition, 'Scenario');
const evidenceIds = new Set(definition.evidence.map(item => item.id));
const actionIds = new Set(definition.actions.map(item => item.id));
assert.equal(evidenceIds.size, definition.evidence.length, 'Duplicate evidence ID');
assert.equal(actionIds.size, definition.actions.length, 'Duplicate action ID');
assert.equal(new Set(definition.eventRules.map(item => item.id)).size, definition.eventRules.length);
assert.equal(new Set(definition.checkpoints.map(item => item.id)).size, definition.checkpoints.length);
assert.deepEqual(Object.keys(definition.variables).sort(), Object.keys(definition.initialState).sort());
for (const id of [...definition.initialEvidence, ...definition.debrief.keyEvidence]) assert.ok(evidenceIds.has(id), 'Unknown evidence ' + id);
for (const id of definition.debrief.recommendedActions) assert.ok(actionIds.has(id), 'Unknown recommended action ' + id);

function checkExpression(expression, allowedArgs = [], depth = 0, counter = { nodes: 0 }) {
  assert.ok(depth <= 20 && ++counter.nodes <= 200, 'Expression exceeds complexity bound');
  if ('ref' in expression) assert.ok(expression.ref === 'tick' || Object.hasOwn(definition.variables, expression.ref), 'Unknown reference ' + expression.ref);
  if ('arg' in expression) assert.ok(allowedArgs.includes(expression.arg), 'Unknown argument ' + expression.arg);
  if ('op' in expression) {
    const arity = { sub: 2, eq: 2, gte: 2, gt: 2, lt: 2, not: 1, if: 3 };
    if (arity[expression.op]) assert.equal(expression.args.length, arity[expression.op], 'Invalid operator arity');
    else assert.ok(expression.args.length >= 2, 'Operator requires at least two operands');
    for (const child of expression.args) checkExpression(child, allowedArgs, depth + 1, counter);
  }
}
for (let left = 0; left < definition.actions.length; left++) {
  for (let right = left + 1; right < definition.actions.length; right++) {
    const a = definition.actions[left], b = definition.actions[right];
    if (a.tool !== b.tool) continue;
    const distinct = Object.keys(a.arguments).some(key => Object.hasOwn(b.arguments, key)
      && a.arguments[key] !== b.arguments[key]);
    assert.ok(distinct, 'Overlapping action selectors: ' + a.id + ' and ' + b.id);
  }
}
for (const action of definition.actions) {
  const tool = registry.tools.find(item => item.name === action.tool);
  assert.ok(tool, 'Unknown tool ' + action.tool);
  for (const [name, value] of Object.entries(action.arguments)) {
    assert.ok(Object.hasOwn(tool.inputSchema.properties, name), 'Unknown selector ' + name);
    valid(ajv.compile(tool.inputSchema.properties[name]), value, 'Selector ' + name);
  }
  for (const id of [...action.reveals, ...action.requiresEvidence]) assert.ok(evidenceIds.has(id), 'Unknown action evidence ' + id);
  checkExpression(action.prerequisite, Object.keys(tool.inputSchema.properties));
  for (const assignment of action.effects) {
    assert.ok(Object.hasOwn(definition.variables, assignment.target));
    checkExpression(assignment.value, Object.keys(tool.inputSchema.properties));
  }
}
for (const rule of definition.tickRules) {
  assert.ok(Object.hasOwn(definition.variables, rule.target));
  checkExpression(rule.value);
}
for (const expression of [definition.impact, definition.resolution, definition.failure,
  ...definition.metrics.map(metric => metric.expression), ...definition.eventRules.map(rule => rule.when)]) checkExpression(expression);
if (definition.status === 'published') {
  assert.equal(definition.provenance.kind, 'adapted');
  assert.ok(definition.provenance.sources.length > 0, 'Published adapted content needs sources');
}

const traces = read('tests/fixtures/reference-traces.json');
assert.equal(traces.scenarioId, definition.id);
assert.equal(traces.scenarioVersion, definition.version);
function execute(commands, initial = start(definition)) {
  return commands.reduce((state, command) => {
    valid(toolSchemas.get(command.tool), command.arguments, command.tool);
    return step(definition, state, command, registry);
  }, structuredClone(initial));
}
for (const trace of traces.paths) {
  const actual = execute(trace.commands);
  const summary = { tick: actual.tick, status: actual.status, impactUnits: actual.impactUnits, variables: actual.variables };
  assert.deepEqual(summary, trace.expected, trace.id);
  assert.deepEqual(execute(trace.commands), actual, 'Nondeterministic trace: ' + trace.id);
}
const alternate = traces.paths.find(trace => trace.id === 'scale-then-rollback');
const checkpoint = execute(alternate.commands.slice(0, 1));
const checkpointCopy = structuredClone(checkpoint);
assert.deepEqual(execute(alternate.commands.slice(1), checkpoint), execute(alternate.commands), 'Checkpoint suffix differs');
assert.deepEqual(checkpoint, checkpointCopy, 'Replay mutated parent fixture');
const request = read('packages/contracts/examples/action-request.json');
const response = read('packages/contracts/examples/action-response.json');
const observed = execute([request.command]);
assert.equal(response.session.tick, observed.tick);
assert.equal(response.session.costs.impactUnits, observed.impactUnits);
assert.equal(response.executedVersion, response.session.version);
assert.deepEqual(response.session.visibleMetrics, metrics(definition, observed).filter(metric => definition.metrics.find(spec => spec.service === metric.service && spec.metric === metric.metric).alwaysVisible));
const sample = response.output.evidence[0].data.samples.at(-1);
assert.deepEqual(sample, { tick: observed.tick, value: metrics(definition, observed).find(metric => metric.metric === 'connections').value });
const initialView = read('packages/contracts/examples/session.json');
assert.deepEqual(initialView.revealedEvidence.map(item => item.id), definition.initialEvidence);
for (const offer of initialView.availableOperations) {
  const action = definition.actions.find(item => item.id === offer.id);
  assert.ok(action && action.requiresEvidence.length === 0, 'Unavailable operation exposed');
  ajv.compile(offer.argumentSchema);
  assert.equal(offer.tool, action.tool);
  assert.equal(offer.costTicks, action.costTicks);
}
assert.throws(() => execute([{ tool: 'inspect_diff', arguments: { deploymentId: 'deploy-2-6-1' } }]), /Evidence prerequisite/);
assert.throws(() => execute([{ tool: 'restart_service', arguments: { service: 'hidden-service' } }]), /exactly one/);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', '.loopx', '.codex', '.local', 'dist', 'coverage'].includes(entry.name)) return [];
    const location = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(location) : [location];
  });
}
const markdown = walk(root).filter(file => file.endsWith('.md'));
for (const file of markdown) {
  const content = fs.readFileSync(file, 'utf8');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), 'Broken link in ' + path.relative(root, file) + ': ' + target);
  }
  assert.ok(!content.includes('\u2014'), 'Em dash in ' + file);
}
console.log('PASS: OpenAPI, ' + Object.keys(publicSchema.$defs).length + ' public schemas, ' + registry.tools.length + ' tools, scenario references, ' + traces.paths.length + ' deterministic traces, replay fixture, negative cases, and ' + markdown.length + ' Markdown files.');
console.log('Application, persistence, UI, and AWS integration are not implemented or tested by this check.');
