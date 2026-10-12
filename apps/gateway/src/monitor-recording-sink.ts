import type { MonitorChunkStore } from './monitor-chunk-store.js';
import type {
  MonitorRecordingBatch,
  MonitorRecordingSink,
  MonitorRecordingStart,
  SealedMonitorRecording,
} from './monitor-recorder.js';
import type { MonitorRecorderLease, MonitorRecordingStateStore } from './monitor-recording-store.js';

export interface DurableMonitorRecordingSinkOptions {
  lease: MonitorRecorderLease;
  chunks: MonitorChunkStore;
  recordings: MonitorRecordingStateStore;
  now?: () => string;
  recordLifecycle?: boolean;
}

export class DurableMonitorRecordingSink implements MonitorRecordingSink {
  private readonly lease: MonitorRecorderLease;
  private readonly chunks: MonitorChunkStore;
  private readonly recordings: MonitorRecordingStateStore;
  private readonly now: () => string;
  private readonly recordLifecycle: boolean;

  constructor(options: DurableMonitorRecordingSinkOptions) {
    this.lease = { ...options.lease };
    this.chunks = options.chunks;
    this.recordings = options.recordings;
    this.now = options.now ?? (() => new Date().toISOString());
    this.recordLifecycle = options.recordLifecycle ?? false;
  }

  async begin(value: MonitorRecordingStart, signal?: AbortSignal): Promise<void> {
    await this.recordings.begin(this.lease, value.startedAt, this.now(), signal);
  }

  async append(value: MonitorRecordingBatch, signal?: AbortSignal): Promise<void> {
    const reference = await this.chunks.putLive(this.lease.sessionId, this.lease.generation, value, signal);
    const latestMetric = [...value.frames].reverse().find((frame) => frame.payload.type === 'metrics');
    const lifecycleMetric =
      value.frames.find((frame) => frame.payload.type === 'metrics' && frame.payload.recovery.state === 'met') ??
      latestMetric;
    const observation =
      this.recordLifecycle && lifecycleMetric?.payload.type === 'metrics'
        ? {
            schemaVersion: 1 as const,
            sessionId: this.lease.sessionId,
            startedAt: value.startedAt,
            source: value.source,
            cursor: value.nextSequence,
            sequence: lifecycleMetric.sequence,
            at: lifecycleMetric.payload.sample.at,
            recovery: lifecycleMetric.payload.recovery,
          }
        : undefined;
    const evidence = {
      schemaVersion: 1 as const,
      source: value.source,
      after: value.after,
      nextSequence: value.nextSequence,
      events: value.frames.flatMap((frame) =>
        frame.payload.type === 'timeline'
          ? [{ sequence: frame.sequence, recordedAt: frame.recordedAt, event: frame.payload.event }]
          : [],
      ),
    };
    const live =
      latestMetric?.payload.type === 'metrics'
        ? {
            schemaVersion: 1 as const,
            sessionId: this.lease.sessionId,
            startedAt: value.startedAt,
            source: value.source,
            frontier: value.nextSequence,
            sequence: latestMetric.sequence,
            recordedAt: latestMetric.recordedAt,
            metric: structuredClone(latestMetric.payload),
          }
        : undefined;
    await this.recordings.append(
      this.lease,
      value.startedAt,
      reference,
      this.now(),
      signal,
      observation,
      evidence,
      live,
    );
  }

  async seal(value: SealedMonitorRecording, signal?: AbortSignal): Promise<void> {
    const reference = await this.chunks.putSealed(this.lease.sessionId, this.lease.generation, value, signal);
    await this.recordings.seal(this.lease, value, reference, this.now(), signal);
  }
}
