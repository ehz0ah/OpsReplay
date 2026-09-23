import type {
  Command,
  Costs,
  Evidence,
  LogicalEvent,
  Metric,
  ReplayOrigin,
  SessionView,
} from '@opsreplay/contracts';
import type { CompiledScenario } from './definition.js';
import type { ExpressionContext } from './expression.js';

export interface Snapshot {
  tick: number;
  status: SessionView['status'];
  variables: Record<string, number | boolean>;
  costs: Costs;
  evidence: Evidence[];
  samples: { tick: number; metrics: Metric[] }[];
  eventFlags: Record<string, boolean>;
  occurrences: { ruleId: string; tick: number }[];
  commandCount: number;
  nextSequence: number;
}

export interface SavedCheckpoint {
  id: string;
  label: string;
  snapshot: Snapshot;
}

export interface EngineState extends Snapshot {
  id: string;
  contentId: string;
  contentVersion: string;
  engineVersion: string;
  version: number;
  mode: SessionView['mode'];
  informedPractice: boolean;
  replayOrigin: ReplayOrigin | null;
  checkpoints: SavedCheckpoint[];
}

export interface ActionRecord {
  actionId: string;
  command: Command;
  startTick: number;
  endTick: number;
  impactUnits: number;
  repeated: boolean;
}

export interface EngineResult {
  state: EngineState;
  events: LogicalEvent[];
  output: { summary: string; evidence: Evidence[] };
  action: ActionRecord | null;
}

export function context(state: Snapshot, args: Record<string, unknown> = {}): ExpressionContext {
  return { state: state.variables, tick: state.tick, arguments: args };
}

export function currentMetrics(scenario: CompiledScenario, state: Snapshot): Metric[] {
  return scenario.metrics.map(({ definition, expression }) => ({
    service: definition.service,
    metric: definition.metric,
    unit: definition.unit,
    value: expression.evaluate(context(state)) as number,
  }));
}

export function snapshot(state: EngineState): Snapshot {
  return structuredClone({
    tick: state.tick,
    status: state.status,
    variables: state.variables,
    costs: state.costs,
    evidence: state.evidence,
    samples: state.samples,
    eventFlags: state.eventFlags,
    occurrences: state.occurrences,
    commandCount: state.commandCount,
    nextSequence: state.nextSequence,
  });
}

export function appendEvent(
  state: Snapshot,
  events: LogicalEvent[],
  kind: LogicalEvent['kind'],
  message: string,
  observations: Evidence[] = [],
): void {
  events.push({
    sequence: state.nextSequence++,
    tick: state.tick,
    kind,
    message,
    evidenceIds: observations.map((item) => item.id),
    observations: structuredClone(observations),
  });
}
