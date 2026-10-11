import { isMonitorControlSource, isMonitorControlTimestamp, monitorControlSchema } from './monitor-control.js';
import { recordingRetainUntil } from './recording-retention.js';
import { isTerminalSessionId } from './terminal-access.js';
import { isLifecycleRecovery, type LifecycleRecovery } from './session-lifecycle.js';

export const monitorRecordingLimits = Object.freeze({ maximumFrames: 10_000 });
export const monitorRecordingIncompleteReasons = [
  'task_lost',
  'recorder_lost',
  'drain_timeout',
  'limit_exceeded',
  'data_gap',
] as const;
export type MonitorRecordingIncompleteReason = (typeof monitorRecordingIncompleteReasons)[number];
export interface MonitorRecordingCheckpoint {
  startedAt: string | null;
  source: string | null;
  cursor: number;
}
export interface StoredMonitorChunk {
  phase: 'live' | 'sealed';
  objectKey: string;
  sha256: string;
  source: string | null;
  after: number;
  nextSequence: number;
  frameCount: number;
}
export type MonitorRecordingStatus = 'recording' | 'draining' | 'complete' | 'incomplete';
export interface MonitorRecordingState extends MonitorRecordingCheckpoint {
  schemaVersion: 1;
  status: MonitorRecordingStatus;
  recorderId: string | null;
  generation: number;
  leaseExpiresAt: string | null;
  cutoffAt: string | null;
  drainDeadlineAt: string | null;
  sealed: StoredMonitorChunk | null;
  retainUntil: string | null;
  reason: string | null;
  updatedAt: string;
  completedAt: string | null;
}
/** Saved in the same transaction as the immutable page reference and cursor. */
export interface MonitorLifecycleObservation {
  schemaVersion: 1;
  sessionId: string;
  startedAt: string;
  source: string;
  cursor: number;
  sequence: number;
  at: string;
  recovery: LifecycleRecovery;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const cursor = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= monitorRecordingLimits.maximumFrames &&
  (value as number) <= monitorControlSchema.maximumCursor;
export function isStoredMonitorChunkReference(
  value: unknown,
  sessionId: string,
  generation: number,
  phase: StoredMonitorChunk['phase'],
): value is StoredMonitorChunk {
  if (
    !record(value) ||
    !exactKeys(value, ['phase', 'objectKey', 'sha256', 'source', 'after', 'nextSequence', 'frameCount']) ||
    !isTerminalSessionId(sessionId) ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > 999_999_999 ||
    value.phase !== phase ||
    typeof value.objectKey !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !cursor(value.after) ||
    !cursor(value.nextSequence) ||
    !cursor(value.frameCount) ||
    (value.source !== null && !isMonitorControlSource(value.source))
  )
    return false;
  const first = value.frameCount === 0 ? 0 : value.after + 1;
  const expected = `sessions/${sessionId}/metrics/${String(generation).padStart(9, '0')}/${phase}/${value.source ?? 'empty'}/${String(first).padStart(6, '0')}-${String(value.nextSequence).padStart(6, '0')}-${value.sha256}.json`;
  if (value.objectKey !== expected) return false;
  return phase === 'live'
    ? value.source !== null &&
        value.frameCount >= 1 &&
        value.frameCount <= monitorControlSchema.maximumFramesPerPage &&
        value.nextSequence > value.after &&
        value.nextSequence - value.after === value.frameCount
    : value.after === 0 &&
        value.nextSequence === value.frameCount &&
        (value.frameCount === 0 ? value.source === null : value.source !== null);
}
export function isMonitorRecordingState(value: unknown, sessionId: string): value is MonitorRecordingState {
  if (
    !record(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'status',
      'recorderId',
      'generation',
      'leaseExpiresAt',
      'startedAt',
      'source',
      'cursor',
      'cutoffAt',
      'drainDeadlineAt',
      'sealed',
      'retainUntil',
      'reason',
      'updatedAt',
      'completedAt',
    ]) ||
    !isTerminalSessionId(sessionId) ||
    value.schemaVersion !== 1 ||
    !['recording', 'draining', 'complete', 'incomplete'].includes(value.status as string) ||
    !Number.isInteger(value.generation) ||
    (value.generation as number) < 1 ||
    (value.generation as number) > 999_999_999 ||
    !isMonitorControlTimestamp(value.updatedAt) ||
    !cursor(value.cursor) ||
    (value.startedAt !== null && !isMonitorControlTimestamp(value.startedAt)) ||
    (value.source !== null && !isMonitorControlSource(value.source)) ||
    (value.startedAt === null
      ? value.source !== null || value.cursor !== 0
      : value.cursor === 0
        ? value.source !== null
        : value.source === null) ||
    ![value.cutoffAt, value.drainDeadlineAt, value.completedAt].every(
      (v) => v === null || isMonitorControlTimestamp(v),
    ) ||
    (value.reason !== null && !(monitorRecordingIncompleteReasons as readonly unknown[]).includes(value.reason))
  )
    return false;
  const state = value as unknown as MonitorRecordingState;
  if (state.status === 'recording' || state.status === 'draining') {
    if (
      state.recorderId === null ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(state.recorderId) ||
      !isMonitorControlTimestamp(state.leaseExpiresAt) ||
      state.sealed !== null ||
      state.retainUntil !== null ||
      state.reason !== null ||
      state.completedAt !== null
    )
      return false;
    return state.status === 'recording'
      ? state.cutoffAt === null && state.drainDeadlineAt === null
      : state.cutoffAt !== null && state.drainDeadlineAt !== null && state.drainDeadlineAt >= state.cutoffAt;
  }
  if (
    state.recorderId !== null ||
    state.leaseExpiresAt !== null ||
    state.cutoffAt === null ||
    state.drainDeadlineAt === null ||
    state.completedAt === null ||
    !isMonitorControlTimestamp(state.retainUntil) ||
    state.drainDeadlineAt < state.cutoffAt ||
    state.completedAt < state.cutoffAt
  )
    return false;
  return state.status === 'complete'
    ? state.reason === null &&
        state.completedAt < state.drainDeadlineAt &&
        state.retainUntil === recordingRetainUntil(state.cutoffAt, 'sealed') &&
        isStoredMonitorChunkReference(state.sealed, sessionId, state.generation, 'sealed') &&
        state.sealed.source === state.source &&
        state.sealed.nextSequence === state.cursor &&
        state.sealed.frameCount === state.cursor
    : state.sealed === null &&
        (monitorRecordingIncompleteReasons as readonly unknown[]).includes(state.reason) &&
        state.retainUntil === recordingRetainUntil(state.startedAt ?? state.completedAt, 'provisional');
}
export function monitorObservationKey(sessionId: string) {
  if (!isTerminalSessionId(sessionId)) throw new Error('Invalid monitor observation identity.');
  return { PK: `SESSION#${sessionId}`, SK: 'MONITOR_OBSERVATION' };
}
export function isMonitorLifecycleObservation(value: unknown, sessionId: string): value is MonitorLifecycleObservation {
  return (
    isTerminalSessionId(sessionId) &&
    record(value) &&
    exactKeys(value, ['schemaVersion', 'sessionId', 'startedAt', 'source', 'cursor', 'sequence', 'at', 'recovery']) &&
    value.schemaVersion === 1 &&
    value.sessionId === sessionId &&
    isMonitorControlTimestamp(value.startedAt) &&
    isMonitorControlTimestamp(value.at) &&
    value.at >= value.startedAt &&
    isMonitorControlSource(value.source) &&
    cursor(value.cursor) &&
    cursor(value.sequence) &&
    value.sequence > 0 &&
    value.sequence <= value.cursor &&
    isLifecycleRecovery(value.recovery) &&
    value.recovery.sustainedSeconds <= Math.floor((Date.parse(value.at) - Date.parse(value.startedAt)) / 1000)
  );
}
