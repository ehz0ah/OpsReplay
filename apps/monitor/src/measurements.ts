import { Counter, Registry, Summary } from '@prometheus-io/client';
import { limits, MonitorError } from './types.js';
import type { MetricFrame } from './types.js';

interface RequestRecord { startedAt: number; completedAt: number; durationMs: number; failed: boolean }
export class Measurements {
  private readonly records: RequestRecord[] = [];
  constructor(readonly startedAt: number) {}

  record(record: RequestRecord): void {
    if (record.startedAt < this.startedAt) return;
    if (![record.startedAt, record.completedAt, record.durationMs].every(Number.isFinite)
      || record.completedAt < record.startedAt || record.durationMs < 0) throw new MonitorError('invalid_boundary');
    if (this.records.length >= limits.records) throw new MonitorError('record_limit');
    this.records.push({ ...record });
  }

  async snapshot(at: number): Promise<Pick<MetricFrame, 'sample' | 'counters'>> {
    if (!Number.isFinite(at) || at < this.startedAt) throw new MonitorError('invalid_boundary');
    // Independent registries also keep concurrent live and cutoff reads isolated.
    const registry = new Registry();
    const total = new Counter({ name: 'requests_total', help: 'Completed journey requests', registers: [registry] });
    const failed = new Counter({ name: 'requests_failed', help: 'Failed journey requests', registers: [registry] });
    const latency = new Summary({ name: 'request_duration_ms', help: 'Last five seconds of request duration',
      percentiles: [0.95], registers: [registry] });
    const from = Math.max(this.startedAt, at - limits.sampleMs);
    let windowRequests = 0;
    let windowFailures = 0;
    for (const record of this.records) {
      if (record.completedAt > at) continue;
      total.inc();
      if (record.failed) failed.inc();
      if (record.completedAt > from || (from === this.startedAt && record.completedAt === from)) {
        windowRequests++;
        if (record.failed) windowFailures++;
        latency.observe(record.durationMs);
      }
    }
    const metrics = await registry.getMetricsAsJSON();
    const totalRequests = metrics.find(m => m.name === 'requests_total')!.values[0]!.value;
    const failedRequests = metrics.find(m => m.name === 'requests_failed')!.values[0]!.value;
    const values: Record<string, number> = {};
    if (at > from) values.request_rate = windowRequests * 1000 / (at - from);
    if (windowRequests > 0) {
      values.error_rate = windowFailures * 100 / windowRequests;
      values.latency_p95 = metrics.find(m => m.name === 'request_duration_ms')!
        .values.find(v => v.labels.quantile === 0.95)!.value;
    }
    if (!Object.values(values).every(Number.isFinite)) throw new MonitorError('monitor_failed');
    return { sample: { at: new Date(at).toISOString(), values }, counters: { totalRequests, failedRequests } };
  }
}
