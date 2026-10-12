import { isMonitorControlTimestamp } from './monitor-control.js';
import { isTerminalSessionId } from './terminal-access.js';
import { recordingWorkOrder, recordingWorkTiming, unfinishedWorkIndex } from './recording-work.js';

export const sessionLifecycle = Object.freeze({
  workPartition: 'LIFECYCLE',
  workSortKey: 'LIFECYCLE',
  drainDurationMs: 30_000,
  heartbeatTimeoutMs: 300_000,
  recorderRecoveryTimeoutMs: 300_000,
  heartbeatWriteIntervalMs: 15_000,
  maximumSweepItems: 25,
});

export interface LifecycleRecovery {
  state: 'failing' | 'sustaining' | 'met';
  sustainedSeconds: number;
  requiredSeconds: number;
}

/** No recorder lease or terminal input ownership is stored here. */
export interface SessionLifecycleState {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  readyAt: string | null;
  terminalSource: string | null;
  lastSeenAt: string | null;
  lastMonitorAt: string | null;
  recovery: LifecycleRecovery | null;
  drainDeadlineAt: string | null;
  taskStoppedAt: string | null;
  schedulesDeleted: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const timestampOrNull = (value: unknown): value is string | null => value === null || isMonitorControlTimestamp(value);

export function isLifecycleRecovery(value: unknown): value is LifecycleRecovery {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    ['failing', 'sustaining', 'met'].includes(value.state as string) &&
    Number.isInteger(value.sustainedSeconds) &&
    (value.sustainedSeconds as number) >= 0 &&
    Number.isInteger(value.requiredSeconds) &&
    (value.requiredSeconds as number) >= 1 &&
    (value.requiredSeconds as number) <= 14_400 &&
    (value.sustainedSeconds as number) <= (value.requiredSeconds as number) &&
    (value.state === 'failing'
      ? value.sustainedSeconds === 0
      : value.state === 'met'
        ? value.sustainedSeconds === value.requiredSeconds
        : (value.sustainedSeconds as number) < (value.requiredSeconds as number))
  );
}

export function lifecycleKey(sessionId: string) {
  if (!isTerminalSessionId(sessionId)) throw new Error('Invalid lifecycle identity.');
  return { PK: `SESSION#${sessionId}`, SK: sessionLifecycle.workSortKey };
}

export function initialSessionLifecycle(sessionId: string, createdAt: string): SessionLifecycleState {
  const value: SessionLifecycleState = {
    schemaVersion: 1,
    sessionId,
    createdAt,
    readyAt: null,
    terminalSource: null,
    lastSeenAt: null,
    lastMonitorAt: null,
    recovery: null,
    drainDeadlineAt: null,
    taskStoppedAt: null,
    schedulesDeleted: false,
  };
  if (!isSessionLifecycleState(value, sessionId)) throw new Error('Invalid lifecycle identity.');
  return value;
}

export function lifecycleWorkItem(state: SessionLifecycleState) {
  if (!isSessionLifecycleState(state, state.sessionId)) throw new Error('Invalid lifecycle state.');
  return {
    ...lifecycleKey(state.sessionId),
    data: state,
    [unfinishedWorkIndex.partitionKey]: sessionLifecycle.workPartition,
    [unfinishedWorkIndex.sortKey]: recordingWorkOrder(state.createdAt, state.sessionId),
  };
}

export function drainDeadlineAt(cutoffAt: string): string {
  if (
    !isMonitorControlTimestamp(cutoffAt) ||
    sessionLifecycle.drainDurationMs > recordingWorkTiming.postSessionWindowMs
  )
    throw new Error('Invalid lifecycle cutoff.');
  return new Date(Date.parse(cutoffAt) + sessionLifecycle.drainDurationMs).toISOString();
}

export function isSessionLifecycleState(value: unknown, sessionId: string): value is SessionLifecycleState {
  if (
    !isTerminalSessionId(sessionId) ||
    !record(value) ||
    Object.keys(value).length !== 11 ||
    value.schemaVersion !== 1 ||
    value.sessionId !== sessionId ||
    !isMonitorControlTimestamp(value.createdAt) ||
    !timestampOrNull(value.readyAt) ||
    !timestampOrNull(value.lastSeenAt) ||
    !timestampOrNull(value.lastMonitorAt) ||
    !timestampOrNull(value.drainDeadlineAt) ||
    !timestampOrNull(value.taskStoppedAt) ||
    typeof value.schedulesDeleted !== 'boolean' ||
    (value.terminalSource !== null && !isTerminalSessionId(value.terminalSource)) ||
    (value.recovery !== null && !isLifecycleRecovery(value.recovery))
  )
    return false;
  if (value.readyAt === null) {
    if (
      value.terminalSource !== null ||
      value.lastSeenAt !== null ||
      value.lastMonitorAt !== null ||
      value.recovery !== null
    )
      return false;
  } else if (
    value.readyAt < value.createdAt ||
    value.terminalSource === null ||
    value.lastSeenAt === null ||
    value.lastSeenAt < value.readyAt ||
    value.lastMonitorAt === null ||
    value.lastMonitorAt < value.readyAt ||
    value.recovery === null
  )
    return false;
  return (
    (value.drainDeadlineAt === null || value.drainDeadlineAt >= value.createdAt) &&
    (value.taskStoppedAt === null || value.taskStoppedAt >= value.createdAt) &&
    (!value.schedulesDeleted || value.taskStoppedAt !== null)
  );
}
