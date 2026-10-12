import { isMonitorControlSource, isMonitorControlTimestamp } from './monitor-control.js';
import { isMonitorMetricFrame, type MonitorMetricFrame } from '../../../apps/gateway/src/monitor-client.js';
export interface MonitorFinalEvidence {
  schemaVersion: 1;
  cutoffAt: string;
  source: string | null;
  cursor: number;
  final: MonitorMetricFrame;
}
/** Small cutoff receipt retained with session results, independent of S3 expiry. */
export function isMonitorFinalEvidence(value: unknown): value is MonitorFinalEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as MonitorFinalEvidence;
  return (
    Object.keys(v).length === 5 &&
    ['schemaVersion', 'cutoffAt', 'source', 'cursor', 'final'].every((k) => Object.hasOwn(v, k)) &&
    v.schemaVersion === 1 &&
    isMonitorControlTimestamp(v.cutoffAt) &&
    Number.isSafeInteger(v.cursor) &&
    v.cursor >= 0 &&
    v.cursor <= 10000 &&
    (v.cursor === 0 ? v.source === null : isMonitorControlSource(v.source)) &&
    isMonitorMetricFrame(v.final) &&
    v.final.counters.failedRequests <= v.final.counters.totalRequests &&
    v.final.sample.at === v.cutoffAt
  );
}
