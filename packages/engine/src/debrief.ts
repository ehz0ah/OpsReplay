import type { Comparison, ComparisonPath, Debrief } from '@opsreplay/contracts';
import type { CompiledScenario } from './definition.js';
import { EngineError } from './errors.js';
import type { ActionRecord, EngineState, SavedCheckpoint } from './state.js';

function terminal(state: EngineState): void {
  if (state.status === 'active')
    throw new EngineError('SESSION_TERMINAL', 'End the attempt before opening its debrief.');
}

export function debrief(
  scenario: CompiledScenario,
  state: EngineState,
  history: ActionRecord[],
): Debrief {
  terminal(state);
  const found = new Set(state.evidence.map((item) => item.id));
  const keyEvidence = scenario.definition.debrief.keyEvidence;
  return {
    sessionId: state.id,
    rootCause: scenario.definition.debrief.rootCause,
    causalChain: [...scenario.definition.debrief.causalChain],
    foundEvidence: keyEvidence.filter((id) => found.has(id)),
    missedEvidence: keyEvidence.filter((id) => !found.has(id)),
    actionFeedback: [
      scenario.definition.debrief.explanation,
      ...history.slice(-99).map((record) => {
        const label =
          scenario.actions.find((item) => item.definition.id === record.actionId)?.definition
            .label ?? 'Action';
        return `Tick ${record.startTick}: ${label}. Elapsed ${record.endTick - record.startTick} ticks, impact ${record.impactUnits} units.${record.repeated ? ' This requested a fresh observation of evidence seen earlier.' : ''}`;
      }),
    ],
    recommendedPath: scenario.definition.debrief.recommendedActions.map(
      (id) => scenario.actions.find((item) => item.definition.id === id)?.definition.label ?? id,
    ),
    sources: structuredClone(scenario.definition.provenance.sources),
    costs: { ...state.costs },
    checkpoints: state.checkpoints.map((item) => ({
      id: item.id,
      tick: item.snapshot.tick,
      label: item.label,
    })),
  };
}

export function replayCheckpoint(parent: EngineState, checkpointId: string): SavedCheckpoint {
  if (parent.status === 'active' || parent.mode === 'replay')
    throw new EngineError(
      'REPLAY_UNAVAILABLE',
      'Replay is available after the original attempt ends.',
    );
  const checkpoint = parent.checkpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) throw new EngineError('REPLAY_UNAVAILABLE', 'This checkpoint is not available.');
  return checkpoint;
}

export function compare(parent: EngineState, child: EngineState): Comparison {
  if (
    child.replayOrigin?.parentSessionId !== parent.id ||
    child.contentVersion !== parent.contentVersion ||
    child.engineVersion !== parent.engineVersion
  )
    throw new EngineError('REPLAY_UNAVAILABLE', 'These attempts do not share a replay checkpoint.');
  const checkpoint = replayCheckpoint(parent, child.replayOrigin.checkpointId);
  const path = (state: EngineState): ComparisonPath => {
    const observedTicks = state.tick - checkpoint.snapshot.tick;
    return {
      sessionId: state.id,
      status: state.status,
      observedTicks,
      recoveryTicks: state.status === 'resolved' ? observedTicks : null,
      impactUnits: state.costs.impactUnits - checkpoint.snapshot.costs.impactUnits,
    };
  };
  return {
    checkpointId: checkpoint.id,
    checkpointTick: checkpoint.snapshot.tick,
    informedPractice: true,
    original: path(parent),
    replay: path(child),
    explanations: [
      'Both paths start at the same saved state. Costs shown here exclude the shared prefix.',
      'Replays are informed practice. The original attempt remains unchanged.',
    ],
  };
}
