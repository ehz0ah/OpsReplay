import { isTerminalSessionId, isTerminalTimestamp } from './terminal-access.js';
import { isTerminalRecordingCheckpoint, type TerminalRecordingCheckpoint } from './terminal-persistence.js';
import { terminalCoversCutoff } from './terminal-sealing.js';
import { isStoredMonitorChunkReference, type StoredMonitorChunk } from './monitor-persistence.js';
import { isMonitorMetricFrame, type MonitorMetricFrame } from '../../../apps/gateway/src/monitor-client.js';

/** Operational bound for task-independent copying, below provisional storage retention. */
export const recordingSealingDurationMs = 24 * 60 * 60 * 1000;
export interface RecordingCoverage {
  schemaVersion: 1;
  sessionId: string;
  cutoffAt: string;
  coveredAt: string;
  taskDrainDeadlineAt: string;
  sealingDeadlineAt: string;
  terminal: TerminalRecordingCheckpoint;
  monitor: StoredMonitorChunk;
  final: MonitorMetricFrame;
}
export const recordingCoverageKey = (sessionId: string) => ({ PK: `SESSION#${sessionId}`, SK: 'RECORDING_COVERAGE' });

/** The monitor object includes its exact final metric. No task access is needed after this receipt. */
export function isRecordingCoverage(value: unknown, sessionId: string): value is RecordingCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RecordingCoverage;
  const keys = [
    'schemaVersion',
    'sessionId',
    'cutoffAt',
    'coveredAt',
    'taskDrainDeadlineAt',
    'sealingDeadlineAt',
    'terminal',
    'monitor',
    'final',
  ];
  if (
    !isTerminalSessionId(sessionId) ||
    Object.keys(v).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(v, key)) ||
    v.schemaVersion !== 1 ||
    v.sessionId !== sessionId ||
    ![v.cutoffAt, v.coveredAt, v.taskDrainDeadlineAt, v.sealingDeadlineAt].every(isTerminalTimestamp) ||
    v.coveredAt < v.cutoffAt ||
    v.coveredAt >= v.taskDrainDeadlineAt ||
    v.sealingDeadlineAt !== new Date(Date.parse(v.coveredAt) + recordingSealingDurationMs).toISOString() ||
    !isTerminalRecordingCheckpoint(v.terminal) ||
    !terminalCoversCutoff(v.terminal, v.cutoffAt) ||
    v.terminal.metadata.observedAt > v.coveredAt ||
    (v.terminal.frontier !== null && v.terminal.frontier.recordedAt > v.coveredAt) ||
    (v.terminal.metadata.loss !== null && v.terminal.metadata.loss.occurredAt <= v.cutoffAt) ||
    typeof v.monitor?.objectKey !== 'string' ||
    !isMonitorMetricFrame(v.final) ||
    v.final.sample.at !== v.cutoffAt ||
    v.final.counters.failedRequests > v.final.counters.totalRequests
  )
    return false;
  const generation = Number(v.monitor.objectKey.split('/')[3]);
  return isStoredMonitorChunkReference(v.monitor, sessionId, generation, 'sealed');
}
