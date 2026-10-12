import { isTerminalSessionId, isTerminalTimestamp } from './terminal-access.js';

export const lifecycleHintPrefix = 'LIFECYCLE_HINT#';
export type LifecycleHintTransition =
  'ready' | 'outcome' | 'recovery_met' | 'coverage' | 'complete' | 'incomplete' | 'playback';

/** Bounded lifecycle hints. Recorder cursor, lease and heartbeat writes never
 * produce hints. Playback continuation emits one hint per pending export pass. */
export function lifecycleHintItem(sessionId: string, transition: LifecycleHintTransition, at: string) {
  if (
    !isTerminalSessionId(sessionId) ||
    !isTerminalTimestamp(at) ||
    !['ready', 'outcome', 'recovery_met', 'coverage', 'complete', 'incomplete', 'playback'].includes(transition)
  )
    throw new Error('Invalid lifecycle hint.');
  return {
    PK: `SESSION#${sessionId}`,
    SK: `${lifecycleHintPrefix}${transition}`,
    data: { schemaVersion: 1, sessionId, transition, at },
  };
}
