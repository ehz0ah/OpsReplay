import { setTimeout as delay } from 'node:timers/promises';
import type { MonitorChunkStore } from './monitor-chunk-store.js';
import type { MonitorRecordingClient } from './monitor-recorder.js';
import { MonitorRecorder, monitorRecordingPolling } from './monitor-recorder.js';
import { DurableMonitorRecordingSink } from './monitor-recording-sink.js';
import {
  MonitorRecordingStoreError,
  monitorRecorderLease,
  type MonitorRecordingLeaseStore,
  type MonitorRecordingState,
  type MonitorRecordingStateStore,
} from './monitor-recording-store.js';

export interface ClosableMonitorRecordingClient extends MonitorRecordingClient {
  close(): void;
}

export type MonitorRecordingRunStatus = 'complete' | 'not_acquired' | 'not_recordable' | 'ownership_lost' | 'cancelled';

export interface MonitorRecordingRunResult {
  status: MonitorRecordingRunStatus;
  generation: number | null;
}

export interface MonitorRecordingRunnerOptions {
  sessionId: string;
  recorderId: string;
  client: ClosableMonitorRecordingClient;
  chunks: MonitorChunkStore;
  recordings: MonitorRecordingLeaseStore & MonitorRecordingStateStore;
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  pollIntervalMs?: number;
  now?: () => string;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export type MonitorRecordingRunnerErrorCode = 'invalid_config' | 'invalid_state';

const messages: Record<MonitorRecordingRunnerErrorCode, string> = {
  invalid_config: 'Monitor recording runner configuration is invalid.',
  invalid_state: 'Monitor recording runner reached an invalid state.',
};

export class MonitorRecordingRunnerError extends Error {
  constructor(readonly code: MonitorRecordingRunnerErrorCode) {
    super(messages[code]);
    this.name = 'MonitorRecordingRunnerError';
  }
}

const defaultRenewalIntervalMs = 5_000;

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal });
}

function isStoreError(error: unknown, ...codes: MonitorRecordingStoreError['code'][]): boolean {
  return error instanceof MonitorRecordingStoreError && codes.includes(error.code);
}

function expectedCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && ['AbortError', 'MonitorClientError'].includes(error.name);
}

function drainingState(value: MonitorRecordingState): value is MonitorRecordingState & {
  status: 'draining';
  cutoffAt: string;
  drainDeadlineAt: string;
} {
  return value.status === 'draining' && value.cutoffAt !== null && value.drainDeadlineAt !== null;
}

export class MonitorRecordingRunner {
  private readonly sessionId: string;
  private readonly recorderId: string;
  private readonly client: ClosableMonitorRecordingClient;
  private readonly chunks: MonitorChunkStore;
  private readonly recordings: MonitorRecordingLeaseStore & MonitorRecordingStateStore;
  private readonly leaseDurationMs: number;
  private readonly renewalIntervalMs: number;
  private readonly pollIntervalMs: number | undefined;
  private readonly now: () => string;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private running = false;
  private used = false;

  constructor(options: MonitorRecordingRunnerOptions) {
    const leaseDurationMs = options.leaseDurationMs ?? monitorRecorderLease.defaultDurationMs;
    const renewalIntervalMs = options.renewalIntervalMs ?? defaultRenewalIntervalMs;
    if (
      !Number.isInteger(leaseDurationMs) ||
      leaseDurationMs < monitorRecorderLease.minimumDurationMs ||
      leaseDurationMs > monitorRecorderLease.maximumDurationMs ||
      !Number.isInteger(renewalIntervalMs) ||
      renewalIntervalMs < 1 ||
      renewalIntervalMs > leaseDurationMs / 2 ||
      (options.pollIntervalMs !== undefined &&
        (!Number.isInteger(options.pollIntervalMs) ||
          options.pollIntervalMs < monitorRecordingPolling.minimumIntervalMs ||
          options.pollIntervalMs > monitorRecordingPolling.maximumIntervalMs))
    ) {
      throw new MonitorRecordingRunnerError('invalid_config');
    }
    this.sessionId = options.sessionId;
    this.recorderId = options.recorderId;
    this.client = options.client;
    this.chunks = options.chunks;
    this.recordings = options.recordings;
    this.leaseDurationMs = leaseDurationMs;
    this.renewalIntervalMs = renewalIntervalMs;
    this.pollIntervalMs = options.pollIntervalMs;
    this.now = options.now ?? (() => new Date().toISOString());
    this.wait = options.wait ?? defaultWait;
  }

  async run(signal: AbortSignal): Promise<MonitorRecordingRunResult> {
    if (this.running || this.used) throw new MonitorRecordingRunnerError('invalid_state');
    this.running = true;
    this.used = true;
    let generation: number | null = null;
    const lifetime = new AbortController();
    const polling = new AbortController();
    const cancel = () => lifetime.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();

    let renewalFailure: unknown;
    let drain: (MonitorRecordingState & { status: 'draining'; cutoffAt: string; drainDeadlineAt: string }) | null =
      null;
    let stopRenewal: AbortController | undefined;
    let renewal: Promise<void> | undefined;

    try {
      if (lifetime.signal.aborted) return { status: 'cancelled', generation };
      let claimed;
      try {
        claimed = await this.recordings.claim(
          {
            sessionId: this.sessionId,
            recorderId: this.recorderId,
            now: this.now(),
            leaseDurationMs: this.leaseDurationMs,
          },
          lifetime.signal,
        );
      } catch (error) {
        if (signal.aborted || expectedCancellation(error, lifetime.signal)) {
          return { status: 'cancelled', generation };
        }
        if (isStoreError(error, 'lease_unavailable')) {
          return { status: 'not_acquired', generation };
        }
        if (isStoreError(error, 'invalid_state')) return { status: 'not_recordable', generation };
        throw error;
      }

      generation = claimed.lease.generation;
      if (drainingState(claimed.state)) {
        drain = claimed.state;
        polling.abort();
      }

      stopRenewal = new AbortController();
      const renewalSignal = AbortSignal.any([lifetime.signal, stopRenewal.signal]);
      renewal = this.renew(claimed.lease, renewalSignal, (state) => {
        if (drainingState(state)) {
          drain = state;
          polling.abort();
        }
      }).catch((error: unknown) => {
        if (renewalSignal.aborted && expectedCancellation(error, renewalSignal)) return;
        renewalFailure = error;
        lifetime.abort(error);
        polling.abort(error);
      });

      const sink = new DurableMonitorRecordingSink({
        lease: claimed.lease,
        chunks: this.chunks,
        recordings: this.recordings,
        now: this.now,
      });
      const recorder = new MonitorRecorder({
        client: this.client,
        sink,
        checkpoint: claimed.state,
        ...(this.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.pollIntervalMs }),
      });

      await recorder.begin(lifetime.signal);
      if (drain === null) {
        const recordSignal = AbortSignal.any([lifetime.signal, polling.signal]);
        try {
          await recorder.record(recordSignal);
        } catch (error) {
          if (!isStoreError(error, 'recording_draining')) throw error;
          const state = await this.recordings.renew(claimed.lease, this.now(), this.leaseDurationMs, lifetime.signal);
          if (!drainingState(state)) throw new MonitorRecordingRunnerError('invalid_state');
          drain = state;
        }
      }

      if (renewalFailure !== undefined) throw renewalFailure;
      if (signal.aborted) return { status: 'cancelled', generation };
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (drain === null) throw new MonitorRecordingRunnerError('invalid_state');

      await recorder.seal(drain.cutoffAt, lifetime.signal);
      return { status: 'complete', generation };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', generation };
      if (isStoreError(error, 'stale_lease')) {
        return { status: 'ownership_lost', generation };
      }
      if (renewalFailure !== undefined) {
        if (isStoreError(renewalFailure, 'stale_lease')) {
          return { status: 'ownership_lost', generation };
        }
        throw renewalFailure;
      }
      throw error;
    } finally {
      stopRenewal?.abort();
      polling.abort();
      lifetime.abort();
      if (renewal !== undefined) await renewal;
      signal.removeEventListener('abort', cancel);
      this.client.close();
      this.running = false;
    }
  }

  private async renew(
    lease: { sessionId: string; recorderId: string; generation: number },
    signal: AbortSignal,
    observe: (state: MonitorRecordingState) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.wait(this.renewalIntervalMs, signal);
      } catch (error) {
        if (expectedCancellation(error, signal)) return;
        throw error;
      }
      if (signal.aborted) return;
      const state = await this.recordings.renew(lease, this.now(), this.leaseDurationMs, signal);
      observe(state);
    }
  }
}
