import type { Command } from '@opsreplay/contracts';
import type { Scenario } from '@opsreplay/contracts/scenario';
import { getTool, validateScenarioShape } from '@opsreplay/contracts/server';
import { validatePublic } from '@opsreplay/contracts/validation';
import { requireDefinition } from './errors.js';
import { checkAssignable, compileExpression, scalarType } from './expression.js';
import type { CompiledExpression, ExpressionTypes, Scalar, ValueType } from './expression.js';

export const ENGINE_VERSION = '0.1.0';
export type ActionDefinition = Scenario['actions'][number];
export type EvidenceDefinition = Scenario['evidence'][number];
export interface CompiledAction {
  definition: ActionDefinition;
  kind: 'investigation' | 'mitigation' | 'time';
  prerequisite: CompiledExpression;
  effects: { target: string; expression: CompiledExpression }[];
  argumentSchema: Record<string, unknown>;
  requiresConfirmation: boolean;
}
export interface CompiledScenario {
  definition: Scenario;
  actions: CompiledAction[];
  tickRules: { target: string; expression: CompiledExpression }[];
  metrics: { definition: Scenario['metrics'][number]; expression: CompiledExpression }[];
  events: { definition: Scenario['eventRules'][number]; expression: CompiledExpression }[];
  impact: CompiledExpression;
  resolution: CompiledExpression;
  failure: CompiledExpression;
}

function validateTarget(action: ActionDefinition, evidence: EvidenceDefinition[]): void {
  // Target names are authored selectors. Only query filters and bounded counts are dynamic.
  const targetKeys: Record<Command['tool'], string[]> = {
    get_metric: ['service', 'metric'],
    query_logs: ['service'],
    list_deployments: ['service'],
    inspect_diff: ['deploymentId'],
    read_runbook: ['runbookId'],
    view_architecture: ['scope'],
    get_service_status: ['service'],
    rollback_deployment: ['service', 'targetVersion'],
    restart_service: ['service'],
    scale_service: ['service'],
    advance_time: [],
  };
  for (const key of targetKeys[action.tool])
    requireDefinition(
      Object.hasOwn(action.arguments, key),
      `Unbound action target ${key}: ${action.id}`,
    );
  const expectedKind: Partial<Record<Command['tool'], EvidenceDefinition['kind']>> = {
    get_metric: 'metric',
    query_logs: 'logs',
    list_deployments: 'deployments',
    inspect_diff: 'diff',
    read_runbook: 'runbook',
    view_architecture: 'architecture',
    get_service_status: 'status',
  };
  for (const item of evidence) {
    const kind = expectedKind[action.tool];
    if (kind) {
      requireDefinition(item.kind === kind, `Evidence kind does not match tool: ${action.id}`);
      if ('service' in item.data)
        requireDefinition(
          item.data.service === action.arguments.service,
          `Evidence service does not match tool: ${action.id}`,
        );
      if (item.kind === 'metric')
        requireDefinition(
          item.data.metric === action.arguments.metric,
          `Evidence metric does not match tool: ${action.id}`,
        );
      if (item.kind === 'diff')
        requireDefinition(
          item.data.deploymentId === action.arguments.deploymentId,
          `Evidence deployment does not match tool: ${action.id}`,
        );
    }
  }
}
interface ParameterSchema {
  type: 'integer' | 'string';
  minimum?: number;
  maximum?: number;
  enum?: Scalar[];
}

function unique(values: string[], label: string): void {
  requireDefinition(new Set(values).size === values.length, `Duplicate ${label}`);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function argumentTypes(action: ActionDefinition) {
  const tool = getTool(action.tool);
  // tools.json is checked against every public Command branch by contracts:check.
  const properties = tool.inputSchema.properties as Record<string, ParameterSchema>;
  const types: Record<string, ValueType> = {};
  const sample: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(properties)) {
    if (Object.hasOwn(action.arguments, key)) {
      const value = action.arguments[key];
      requireDefinition(
        typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number',
        'Selectors must be scalar',
      );
      types[key] = scalarType(value);
      sample[key] = value;
    } else {
      if (schema.type === 'integer') {
        requireDefinition(
          schema.minimum !== undefined && schema.maximum !== undefined,
          `Unbounded argument: ${key}`,
        );
        types[key] = { type: 'integer', minimum: schema.minimum, maximum: schema.maximum };
        sample[key] = schema.minimum;
      } else {
        types[key] = { type: 'string' };
        sample[key] = schema.enum?.[0] ?? 'sample';
      }
    }
  }
  for (const key of Object.keys(action.arguments))
    requireDefinition(Object.hasOwn(properties, key), `Unknown selector: ${key}`);
  requireDefinition(
    validatePublic('Command', { tool: action.tool, arguments: sample }).ok,
    `Invalid selector: ${action.id}`,
  );
  return { types, tool };
}

export function compileScenario(input: unknown): CompiledScenario {
  // Bound recursion before AJV traverses the recursive expression schema.
  // An expression of depth 20 uses at most 45 object/array levels in a definition.
  const pending = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop();
    requireDefinition(
      entry && entry.depth <= 50 && ++nodes <= 100000,
      'Scenario exceeds structural limits',
    );
    if (entry.value && typeof entry.value === 'object') {
      for (const value of Object.values(entry.value))
        pending.push({ value, depth: entry.depth + 1 });
    }
  }
  const shape = validateScenarioShape(input);
  requireDefinition(shape.ok, 'Scenario does not match its schema');
  const definition = structuredClone(shape.value);
  requireDefinition(definition.engineVersion === ENGINE_VERSION, 'Unsupported engine version');
  const { variables, initialState, services } = definition;
  unique(services, 'service');
  unique(
    definition.evidence.map((item) => item.id),
    'evidence ID',
  );
  unique(
    definition.actions.map((item) => item.id),
    'action ID',
  );
  unique(
    definition.eventRules.map((item) => item.id),
    'event ID',
  );
  unique(
    definition.checkpoints.map((item) => item.id),
    'checkpoint ID',
  );
  unique(
    definition.checkpoints.map((item) => item.trigger),
    'checkpoint trigger',
  );
  unique(
    definition.metrics.map((item) => `${item.service}:${item.metric}`),
    'metric',
  );
  requireDefinition(
    Object.keys(variables).length === Object.keys(initialState).length,
    'Initial state must match variables',
  );
  for (const [key, spec] of Object.entries(variables)) {
    requireDefinition(
      !['tick', '__proto__', 'constructor', 'prototype'].includes(key),
      `Reserved state name: ${key}`,
    );
    if (spec.type === 'integer')
      requireDefinition(
        Number.isSafeInteger(spec.minimum) &&
          Number.isSafeInteger(spec.maximum) &&
          spec.minimum <= spec.maximum,
        `Invalid bounds: ${key}`,
      );
    requireDefinition(Object.hasOwn(initialState, key), `Missing initial state: ${key}`);
    const value = initialState[key];
    requireDefinition(value !== undefined, `Missing initial state: ${key}`);
    checkAssignable(scalarType(value), spec, key);
  }
  const evidence = new Map(definition.evidence.map((item) => [item.id, item]));
  const actionIds = new Set(definition.actions.map((item) => item.id));
  const eventIds = new Set(definition.eventRules.map((item) => item.id));
  for (const id of [...definition.initialEvidence, ...definition.debrief.keyEvidence])
    requireDefinition(evidence.has(id), `Unknown evidence: ${id}`);
  unique(definition.initialEvidence, 'initial evidence');
  for (const id of definition.debrief.recommendedActions)
    requireDefinition(actionIds.has(id), `Unknown recommended action: ${id}`);
  if (definition.status === 'published')
    requireDefinition(
      definition.provenance.kind === 'adapted' && definition.provenance.sources.length > 0,
      'Published content needs reviewed source attribution',
    );
  for (const item of definition.metrics)
    requireDefinition(services.includes(item.service), `Unknown metric service: ${item.service}`);
  const deployments = new Map<string, string>();
  for (const item of definition.evidence) {
    if ('service' in item.data)
      requireDefinition(
        services.includes(item.data.service),
        `Unknown evidence service: ${item.id}`,
      );
    if (item.kind === 'metric' || item.kind === 'status')
      requireDefinition(
        definition.metrics.some(
          (metric) => metric.service === item.data.service && metric.metric === item.data.metric,
        ),
        `Unknown evidence metric: ${item.id}`,
      );
    if (item.kind === 'logs')
      for (const template of item.data.templates)
        requireDefinition(eventIds.has(template.event), `Unknown log event: ${template.event}`);
    if (item.kind === 'deployments')
      for (const deployment of item.data.deployments) {
        requireDefinition(
          !deployments.has(deployment.id),
          `Duplicate deployment: ${deployment.id}`,
        );
        deployments.set(deployment.id, item.id);
      }
    if (item.kind === 'architecture') {
      unique(item.data.services, 'architecture service');
      for (const service of item.data.services)
        requireDefinition(services.includes(service), `Unknown architecture service: ${service}`);
      for (const edge of item.data.dependencies)
        requireDefinition(
          item.data.services.includes(edge.from) && item.data.services.includes(edge.to),
          `Unknown dependency endpoint: ${item.id}`,
        );
    }
  }
  for (const item of definition.evidence)
    if (item.kind === 'diff') {
      requireDefinition(
        deployments.has(item.data.deploymentId),
        `Unknown diff deployment: ${item.id}`,
      );
      unique(
        item.data.lines.map((line) => line.id),
        'diff line',
      );
    }
  const globalTypes: ExpressionTypes = { state: variables, arguments: {} };
  const compile = (
    expr: Parameters<typeof compileExpression>[0],
    expected: ValueType['type'],
    types = globalTypes,
  ) => {
    const compiled = compileExpression(expr, types);
    requireDefinition(compiled.result.type === expected, `Expected ${expected} expression`);
    return compiled;
  };
  const assignments = (rules: Scenario['tickRules'], types: ExpressionTypes) =>
    rules.map((rule) => {
      const spec = Object.hasOwn(variables, rule.target) ? variables[rule.target] : undefined;
      requireDefinition(spec, `Unknown assignment target: ${rule.target}`);
      const expression = compileExpression(rule.value, types);
      checkAssignable(expression.result, spec, rule.target);
      return { target: rule.target, expression };
    });
  const actions = definition.actions.map((action): CompiledAction => {
    const { types, tool } = argumentTypes(action);
    requireDefinition(
      ['investigation', 'mitigation', 'time'].includes(tool.kind),
      'Invalid tool kind',
    );
    if (action.costFromArgument)
      requireDefinition(action.tool === 'advance_time', 'Only advance_time has variable tick cost');
    if ('service' in action.arguments)
      requireDefinition(
        typeof action.arguments.service === 'string' && services.includes(action.arguments.service),
        `Unknown action service: ${action.id}`,
      );
    unique(action.reveals, 'action reveal');
    for (const id of [...action.reveals, ...action.requiresEvidence])
      requireDefinition(evidence.has(id), `Unknown action evidence: ${id}`);
    validateTarget(
      action,
      definition.evidence.filter((item) => action.reveals.includes(item.id)),
    );
    for (const id of action.reveals) {
      const item = evidence.get(id);
      if (item?.kind === 'diff')
        requireDefinition(
          action.requiresEvidence.includes(deployments.get(item.data.deploymentId) ?? ''),
          `Diff requires deployment discovery: ${action.id}`,
        );
    }
    const properties = structuredClone(tool.inputSchema.properties) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [key, value] of Object.entries(action.arguments))
      properties[key] = { ...properties[key], const: value };
    return {
      definition: action,
      kind: tool.kind as CompiledAction['kind'],
      prerequisite: compile(action.prerequisite, 'boolean', { state: variables, arguments: types }),
      effects: assignments(action.effects, { state: variables, arguments: types }),
      argumentSchema: { ...tool.inputSchema, properties },
      requiresConfirmation: tool.requiresConfirmation,
    };
  });
  for (const [i, left] of actions.entries())
    for (const right of actions.slice(i + 1)) {
      if (left.definition.tool !== right.definition.tool) continue;
      requireDefinition(
        Object.entries(left.definition.arguments).some(
          ([key, value]) =>
            Object.hasOwn(right.definition.arguments, key) &&
            right.definition.arguments[key] !== value,
        ),
        `Overlapping selectors: ${left.definition.id}`,
      );
    }
  const impact = compile(definition.impact, 'integer');
  requireDefinition(
    impact.result.type === 'integer' &&
      impact.result.minimum >= 0 &&
      impact.result.maximum <= 1000000000 / 5000,
    'Impact must fit the public cost limit across a session',
  );
  const compiled: CompiledScenario = {
    definition,
    actions,
    tickRules: assignments(definition.tickRules, globalTypes),
    metrics: definition.metrics.map((item) => ({
      definition: item,
      expression: compile(item.expression, 'integer'),
    })),
    events: definition.eventRules.map((item) => ({
      definition: item,
      expression: compile(item.when, 'boolean'),
    })),
    impact,
    resolution: compile(definition.resolution, 'boolean'),
    failure: compile(definition.failure, 'boolean'),
  };
  return freeze(compiled);
}

export function matchesAction(action: ActionDefinition, command: Command): boolean {
  const args: Record<string, unknown> = command.arguments;
  return (
    action.tool === command.tool &&
    Object.entries(action.arguments).every(
      ([key, value]) => Object.hasOwn(args, key) && args[key] === value,
    )
  );
}
