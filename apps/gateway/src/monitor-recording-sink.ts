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
}

export class DurableMonitorRecordingSink implements MonitorRecordingSink {
  private readonly lease: MonitorRecorderLease;
  private readonly chunks: MonitorChunkStore;
  private readonly recordings: MonitorRecordingStateStore;
  private readonly now: () => string;

  constructor(options: DurableMonitorRecordingSinkOptions) {
    this.lease = { ...options.lease };
    this.chunks = options.chunks;
    this.recordings = options.recordings;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async begin(value: MonitorRecordingStart, signal?: AbortSignal): Promise<void> {
    await this.recordings.begin(this.lease, value.startedAt, this.now(), signal);
  }

  async append(value: MonitorRecordingBatch, signal?: AbortSignal): Promise<void> {
    const reference = await this.chunks.putLive(this.lease.sessionId, this.lease.generation, value, signal);
    await this.recordings.append(this.lease, value.startedAt, reference, this.now(), signal);
  }

  async seal(value: SealedMonitorRecording, signal?: AbortSignal): Promise<void> {
    const reference = await this.chunks.putSealed(this.lease.sessionId, this.lease.generation, value, signal);
    await this.recordings.seal(this.lease, value, reference, this.now(), signal);
  }
}
