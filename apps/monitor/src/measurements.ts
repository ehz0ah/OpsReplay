import { limits, MonitorError } from './types.js';
import type { MetricFrame } from './types.js';

interface RequestRecord {
  completedAt: number;
  durationMs: number;
  failed: boolean;
  failedTotal: number;
}
interface RequestInput {
  startedAt: number;
  completedAt: number;
  durationMs: number;
  failed: boolean;
}
export class Measurements {
  private readonly records: RequestRecord[] = [];
  constructor(readonly startedAt: number) {}

  record(record: RequestInput): void {
    if (record.startedAt < this.startedAt) return;
    if (
      ![record.startedAt, record.completedAt, record.durationMs].every(Number.isFinite) ||
      record.completedAt < record.startedAt ||
      record.durationMs < 0 ||
      record.completedAt < (this.records.at(-1)?.completedAt ?? this.startedAt)
    ) {
      throw new MonitorError('invalid_boundary');
    }
    if (this.records.length >= limits.requestRecords) throw new MonitorError('record_limit');
    const failedTotal = (this.records.at(-1)?.failedTotal ?? 0) + Number(record.failed);
    this.records.push({
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      failed: record.failed,
      failedTotal,
    });
  }

  private firstAfter(at: number): number {
    let low = 0;
    let high = this.records.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.records[middle]!.completedAt <= at) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  snapshot(at: number): Pick<MetricFrame, 'sample' | 'counters'> {
    if (!Number.isFinite(at) || at < this.startedAt) throw new MonitorError('invalid_boundary');
    const from = Math.max(this.startedAt, at - limits.sampleMs);
    const end = this.firstAfter(at);
    const start =
      from === this.startedAt ? this.records.findIndex((record) => record.completedAt >= from) : this.firstAfter(from);
    const windowStart = start < 0 ? end : Math.min(start, end);
    const windowRequests = end - windowStart;
    let windowFailures = 0;
    const durations: number[] = [];
    for (let i = windowStart; i < end; i++) {
      const record = this.records[i]!;
      if (record.failed) windowFailures++;
      durations.push(record.durationMs);
    }
    const totalRequests = end;
    const failedRequests = end === 0 ? 0 : this.records[end - 1]!.failedTotal;
    const values: Record<string, number> = {};
    if (at > from) values.request_rate = (windowRequests * 1000) / (at - from);
    if (windowRequests > 0) {
      values.error_rate = (windowFailures * 100) / windowRequests;
      durations.sort((a, b) => a - b);
      values.latency_p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    }
    if (!Object.values(values).every(Number.isFinite)) throw new MonitorError('monitor_failed');
    return { sample: { at: new Date(at).toISOString(), values }, counters: { totalRequests, failedRequests } };
  }
}
