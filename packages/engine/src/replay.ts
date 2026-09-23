import type { LogicalEvent } from '@opsreplay/contracts';
import { replayCheckpoint } from './debrief.js';
import { appendEvent } from './state.js';
import type { EngineResult, EngineState } from './state.js';

export function replay(parent: EngineState, checkpointId: string, id: string): EngineResult {
  const checkpoint = replayCheckpoint(parent, checkpointId);
  const state: EngineState = {
    ...structuredClone(checkpoint.snapshot),
    id,
    contentId: parent.contentId,
    contentVersion: parent.contentVersion,
    engineVersion: parent.engineVersion,
    version: 0,
    mode: 'replay',
    informedPractice: true,
    checkpoints: [],
    nextSequence: 0,
    replayOrigin: {
      parentSessionId: parent.id,
      checkpointId,
      checkpointTick: checkpoint.snapshot.tick,
    },
  };
  const events: LogicalEvent[] = [];
  appendEvent(state, events, 'replay_started', `Informed practice from tick ${state.tick}.`);
  return {
    state,
    events,
    output: { summary: 'Checkpoint restored.', evidence: structuredClone(state.evidence) },
    action: null,
  };
}
