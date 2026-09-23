import type { Command, LogicalEvent, OperationOffer, SessionView } from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';
import type { CompiledAction, CompiledScenario } from './definition.js';
import { ENGINE_VERSION, matchesAction } from './definition.js';
import { EngineError, requireDefinition } from './errors.js';
import { reveal } from './evidence.js';
import { MAX_TICK } from './expression.js';
import { appendEvent, context, currentMetrics, snapshot } from './state.js';
import type { EngineResult, EngineState } from './state.js';

function capture(
  scenario: CompiledScenario,
  state: EngineState,
  trigger: 'start' | 'before_first_mitigation',
): void {
  if (state.mode === 'replay') return;
  const checkpoint = scenario.definition.checkpoints.find((item) => item.trigger === trigger);
  if (checkpoint && !state.checkpoints.some((item) => item.id === checkpoint.id)) {
    state.checkpoints.push({
      id: checkpoint.id,
      label: checkpoint.label,
      snapshot: snapshot(state),
    });
  }
}

function pinned(scenario: CompiledScenario, state: EngineState): void {
  requireDefinition(
    state.contentId === scenario.definition.id &&
      state.contentVersion === scenario.definition.version &&
      state.engineVersion === ENGINE_VERSION,
    'Session content or engine version mismatch',
  );
}

function sample(scenario: CompiledScenario, state: EngineState): void {
  state.samples.push({ tick: state.tick, metrics: currentMetrics(scenario, state) });
  // Tools accept windows up to ten intervals. Requested observations persist in event batches.
  state.samples = state.samples.filter((entry) => entry.tick >= state.tick - 10);
}

export function start(scenario: CompiledScenario, id: string): EngineResult {
  const state: EngineState = {
    id,
    contentId: scenario.definition.id,
    contentVersion: scenario.definition.version,
    engineVersion: ENGINE_VERSION,
    version: 0,
    tick: 0,
    status: 'active',
    mode: 'first_attempt',
    informedPractice: false,
    replayOrigin: null,
    variables: structuredClone(scenario.definition.initialState),
    costs: { elapsedTicks: 0, investigationTicks: 0, impactUnits: 0 },
    evidence: [],
    samples: [],
    eventFlags: {},
    occurrences: [],
    checkpoints: [],
    commandCount: 0,
    nextSequence: 0,
  };
  sample(scenario, state);
  // A condition already true at start is recorded once as initial visible evidence.
  const events: LogicalEvent[] = [];
  appendEvent(state, events, 'session_started', 'Incident started.');
  emitRules(scenario, state, events);
  const evidence = reveal(scenario, state, scenario.definition.initialEvidence);
  appendEvent(state, events, 'observation', 'Initial alert received.', evidence);
  capture(scenario, state, 'start');
  return { state, events, output: { summary: 'Incident started.', evidence }, action: null };
}

function emitRules(scenario: CompiledScenario, state: EngineState, events: LogicalEvent[]): void {
  for (const rule of scenario.events) {
    const active = rule.expression.evaluate(context(state)) === true;
    if (active && !state.eventFlags[rule.definition.id]) {
      state.occurrences.push({ ruleId: rule.definition.id, tick: state.tick });
      appendEvent(state, events, 'incident_event', rule.definition.message);
    }
    state.eventFlags[rule.definition.id] = active;
  }
  state.occurrences = state.occurrences.filter((entry) => entry.tick >= state.tick - 10);
}

function activeState(state: EngineState, expectedVersion: number): void {
  if (state.version !== expectedVersion)
    throw new EngineError(
      'VERSION_CONFLICT',
      'Session changed. Refresh before choosing an action.',
    );
  if (state.status !== 'active')
    throw new EngineError('SESSION_TERMINAL', 'This attempt has ended. Open the debrief.');
  if (state.commandCount >= 500)
    throw new EngineError('LIMIT_EXCEEDED', 'This attempt has reached the command limit.');
}

function hasEvidence(action: CompiledAction, state: EngineState): boolean {
  if (
    !action.definition.requiresEvidence.every((id) => state.evidence.some((item) => item.id === id))
  )
    return false;
  if (action.definition.tool === 'inspect_diff') {
    return state.evidence.some(
      (item) =>
        item.kind === 'deployments' &&
        item.data.deployments.some(
          (deployment) => deployment.id === action.definition.arguments.deploymentId,
        ),
    );
  }
  return true;
}

function validateAction(
  scenario: CompiledScenario,
  state: EngineState,
  command: Command,
): CompiledAction {
  const actions = scenario.actions.filter((action) => matchesAction(action.definition, command));
  if (actions.length !== 1)
    throw new EngineError(
      'ACTION_UNAVAILABLE',
      'This operation is not available for the selected target.',
    );
  const action = actions[0];
  requireDefinition(action, 'Missing matched action');
  if (
    !hasEvidence(action, state) ||
    action.prerequisite.evaluate(context(state, command.arguments)) !== true
  )
    throw new EngineError(
      'PREREQUISITE_FAILED',
      'Inspect the required evidence before this action.',
    );
  return action;
}

export function step(
  scenario: CompiledScenario,
  previous: EngineState,
  input: unknown,
  expectedVersion: number,
): EngineResult {
  pinned(scenario, previous);
  activeState(previous, expectedVersion);
  const parsed = validatePublic('Command', input);
  if (!parsed.ok)
    throw new EngineError('INVALID_REQUEST', 'Command does not match an allowed operation.');
  const command = parsed.value;
  const action = validateAction(scenario, previous, command);
  const state = structuredClone(previous);
  if (action.kind === 'mitigation') capture(scenario, state, 'before_first_mitigation');
  state.version++;
  state.commandCount++;
  const events: LogicalEvent[] = [];
  appendEvent(state, events, 'action_started', action.definition.label);
  for (const effect of action.effects) {
    const value = effect.expression.evaluate(context(state, command.arguments));
    requireDefinition(typeof value !== 'string', 'State assignments cannot be strings');
    state.variables[effect.target] = value;
  }
  const duration =
    action.definition.costFromArgument && command.tool === 'advance_time'
      ? command.arguments.ticks
      : action.definition.costTicks;
  for (let elapsed = 0; elapsed < duration; elapsed++) {
    state.tick++;
    if (state.tick > MAX_TICK)
      throw new EngineError('LIMIT_EXCEEDED', 'Simulated time limit reached.');
    for (const rule of scenario.tickRules) {
      const value = rule.expression.evaluate(context(state));
      requireDefinition(typeof value !== 'string', 'State assignments cannot be strings');
      state.variables[rule.target] = value;
    }
    sample(scenario, state);
    state.costs.elapsedTicks++;
    if (action.kind === 'investigation') state.costs.investigationTicks++;
    state.costs.impactUnits += scenario.impact.evaluate(context(state)) as number;
    emitRules(scenario, state, events);
    if (scenario.failure.evaluate(context(state)) === true) {
      state.status = 'failed';
      appendEvent(state, events, 'incident_failed', 'Incident exceeded its failure limit.');
    } else if (scenario.resolution.evaluate(context(state)) === true) {
      state.status = 'resolved';
      appendEvent(state, events, 'incident_resolved', 'Service recovery conditions met.');
    }
    if (state.status !== 'active') break;
  }
  const evidence = reveal(scenario, state, action.definition.reveals, command);
  const summary = `${action.definition.label}. ${state.tick - previous.tick} simulated tick${state.tick - previous.tick === 1 ? '' : 's'} elapsed.`;
  appendEvent(state, events, 'action_completed', summary, evidence);
  if (events.length > 100)
    throw new EngineError('LIMIT_EXCEEDED', 'This action produces too many events.');
  return {
    state,
    events,
    output: { summary, evidence },
    action: {
      actionId: action.definition.id,
      command: structuredClone(command),
      startTick: previous.tick,
      endTick: state.tick,
      impactUnits: state.costs.impactUnits - previous.costs.impactUnits,
      repeated:
        action.definition.reveals.length > 0 &&
        action.definition.reveals.every((id) => previous.evidence.some((item) => item.id === id)),
    },
  };
}

export function end(
  scenario: CompiledScenario,
  previous: EngineState,
  expectedVersion: number,
): EngineResult {
  pinned(scenario, previous);
  if (previous.version !== expectedVersion)
    throw new EngineError(
      'VERSION_CONFLICT',
      'Session changed. Refresh before ending the attempt.',
    );
  if (previous.status !== 'active')
    throw new EngineError('SESSION_TERMINAL', 'This attempt has already ended.');
  const state = structuredClone(previous);
  state.version++;
  state.status = 'ended';
  const events: LogicalEvent[] = [];
  appendEvent(state, events, 'session_ended', 'Attempt ended by the learner.');
  return { state, events, output: { summary: 'Attempt ended.', evidence: [] }, action: null };
}

export function project(scenario: CompiledScenario, state: EngineState): SessionView {
  pinned(scenario, state);
  const availableOperations: OperationOffer[] =
    state.status === 'active'
      ? scenario.actions
          .filter(
            (action) =>
              hasEvidence(action, state) &&
              (action.prerequisite.usesArguments ||
                action.prerequisite.evaluate(context(state)) === true),
          )
          .map((action) => ({
            id: action.definition.id,
            tool: action.definition.tool,
            label: action.definition.label,
            argumentSchema: structuredClone(action.argumentSchema),
            costTicks: action.definition.costTicks,
            costFromArgument: action.definition.costFromArgument ?? null,
            requiresConfirmation: action.requiresConfirmation,
          }))
      : [];
  const visible = new Set(
    scenario.definition.metrics
      .filter((metric) => metric.alwaysVisible)
      .map((metric) => `${metric.service}:${metric.metric}`),
  );
  return structuredClone({
    id: state.id,
    contentId: state.contentId,
    contentVersion: state.contentVersion,
    engineVersion: state.engineVersion,
    version: state.version,
    tick: state.tick,
    tickSeconds: scenario.definition.tickSeconds,
    status: state.status,
    mode: state.mode,
    informedPractice: state.informedPractice,
    replayOrigin: state.replayOrigin,
    costs: state.costs,
    revealedEvidence: state.evidence,
    availableOperations,
    visibleMetrics: currentMetrics(scenario, state).filter((metric) =>
      visible.has(`${metric.service}:${metric.metric}`),
    ),
    checkpoints:
      state.status === 'active'
        ? []
        : state.checkpoints.map((item) => ({
            id: item.id,
            label: item.label,
            tick: item.snapshot.tick,
          })),
  });
}
