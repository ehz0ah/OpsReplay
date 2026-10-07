import { setTimeout as delay } from 'node:timers/promises';
import { MonitorClient, type MonitorClientOptions } from './monitor-client.js';
import type { MonitorChunkStore } from './monitor-chunk-store.js';
import {
  MonitorRecordingRunner,
  type ClosableMonitorRecordingClient,
  type MonitorRecordingRunResult,
} from './monitor-recording-runner.js';
import type { MonitorRecordingLeaseStore, MonitorRecordingStateStore } from './monitor-recording-store.js';

export interface MonitorRecordingWork {
  sessionId: string;
  monitor: MonitorClientOptions;
}

/**
 * The source owns discovery, validation, and pacing. It must return only work whose
 * task address and monitor credentials came from the private session record.
 */
export interface MonitorRecordingWorkSource {
  next(signal: AbortSignal): Promise<MonitorRecordingWork | null>;
}

export interface MonitorRecordingWorkerOptions {
  recorderId: string;
  source: MonitorRecordingWorkSource;
  chunks: MonitorChunkStore;
  recordings: MonitorRecordingLeaseStore & MonitorRecordingStateStore;
  retryIntervalMs?: number;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  pollIntervalMs?: number;
  createClient?: (options: MonitorClientOptions) => ClosableMonitorRecordingClient;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type MonitorRecordingWorkerErrorCode = 'invalid_config' | 'invalid_state';

const messages: Record<MonitorRecordingWorkerErrorCode, string> = {
  invalid_config: 'Monitor recording worker configuration is invalid.',
  invalid_state: 'Monitor recording worker state does not permit this operation.',
};

export class MonitorRecordingWorkerError extends Error {
  constructor(readonly code: MonitorRecordingWorkerErrorCode) {
    super(messages[code]);
    this.name = 'MonitorRecordingWorkerError';
  }
}

const defaultRetryIntervalMs = 1_000;
const maximumRetryIntervalMs = 30_000;

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal });
}

export class MonitorRecordingWorker {
  private readonly options: MonitorRecordingWorkerOptions;
  private readonly retryIntervalMs: number;
  private readonly createClient: (options: MonitorClientOptions) => ClosableMonitorRecordingClient;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private running = false;

  constructor(options: MonitorRecordingWorkerOptions) {
    const retryIntervalMs = options.retryIntervalMs ?? defaultRetryIntervalMs;
    if (!Number.isInteger(retryIntervalMs) || retryIntervalMs < 1 || retryIntervalMs > maximumRetryIntervalMs) {
      throw new MonitorRecordingWorkerError('invalid_config');
    }
    this.options = options;
    this.retryIntervalMs = retryIntervalMs;
    this.createClient = options.createClient ?? ((clientOptions) => new MonitorClient(clientOptions));
    this.wait = options.wait ?? defaultWait;
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new MonitorRecordingWorkerError('invalid_state');
    this.running = true;
    try {
      while (!signal.aborted) {
        let work: MonitorRecordingWork | null;
        try {
          work = await this.options.source.next(signal);
        } catch (error) {
          if (signal.aborted) return;
          throw error;
        }
        if (signal.aborted) return;
        if (work === null) {
          if (!(await this.pause(signal))) return;
          continue;
        }

        const result = await this.runSession(work, signal);
        if (result.status !== 'complete' && !(await this.pause(signal))) return;
      }
    } finally {
      this.running = false;
    }
  }

  private async runSession(work: MonitorRecordingWork, signal: AbortSignal): Promise<MonitorRecordingRunResult> {
    const client = this.createClient(work.monitor);
    let runner: MonitorRecordingRunner;
    try {
      runner = new MonitorRecordingRunner({
        sessionId: work.sessionId,
        recorderId: this.options.recorderId,
        client,
        chunks: this.options.chunks,
        recordings: this.options.recordings,
        ...(this.options.leaseDurationMs === undefined ? {} : { leaseDurationMs: this.options.leaseDurationMs }),
        ...(this.options.renewalIntervalMs === undefined ? {} : { renewalIntervalMs: this.options.renewalIntervalMs }),
        ...(this.options.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.options.pollIntervalMs }),
      });
    } catch (error) {
      client.close();
      throw error;
    }
    return await runner.run(signal);
  }

  private async pause(signal: AbortSignal): Promise<boolean> {
    try {
      await this.wait(this.retryIntervalMs, signal);
      return !signal.aborted;
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    }
  }
}
