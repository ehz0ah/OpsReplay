import { setTimeout as delay } from 'node:timers/promises';
import type { MonitorChunkStore, StoredMonitorChunk } from './monitor-chunk-store.js';
import type { MonitorRecordingClient, SealedMonitorRecording } from './monitor-recorder.js';
import type { TerminalRecordingCheckpoint } from '../../../packages/contracts/private/terminal-persistence.js';
import type { RecordingCoverage } from '../../../packages/contracts/private/recording-coverage.js';
import { terminalCoversCutoff } from './terminal-recorder.js';
import { MonitorRecorder, monitorRecordingPolling } from './monitor-recorder.js';
import { DurableMonitorRecordingSink } from './monitor-recording-sink.js';
import { TerminalRecorder, TerminalRecorderError, type TerminalRecordingConnection } from './terminal-recorder.js';
import { DurableTerminalRecordingSink } from './terminal-recording-sink.js';
import { TerminalSealer } from './terminal-sealer.js';
import type { TerminalChunkStore } from './terminal-chunk-store.js';
import type { TerminalPageArchive } from './terminal-page-archive.js';
import type { TerminalSealingStore } from './terminal-sealing-store.js';
import { TerminalRecordingStoreError, type TerminalRecordingStateStore } from './terminal-recording-store.js';
import {
  MonitorRecordingStoreError,
  monitorRecorderLease,
  type MonitorRecordingLifecycleStore,
  type MonitorRecordingLeaseStore,
  type MonitorRecordingState,
  type MonitorRecordingStateStore,
} from './monitor-recording-store.js';

export interface ClosableMonitorRecordingClient extends MonitorRecordingClient {
  close(): void;
}

export type MonitorRecordingRunStatus =
  'complete' | 'incomplete' | 'not_acquired' | 'not_recordable' | 'ownership_lost' | 'cancelled';

export interface MonitorRecordingRunResult {
  status: MonitorRecordingRunStatus;
  generation: number | null;
}

export interface MonitorRecordingRunnerOptions {
  sessionId: string;
  recorderId: string;
  client: ClosableMonitorRecordingClient;
  chunks: MonitorChunkStore;
  recordings: MonitorRecordingLeaseStore & MonitorRecordingStateStore & MonitorRecordingLifecycleStore;
  terminal?: {
    connect(signal: AbortSignal): Promise<TerminalRecordingConnection>;
    chunks: TerminalChunkStore;
    recordings: TerminalRecordingStateStore;
    pages: TerminalPageArchive;
    seals: TerminalSealingStore;
    pollIntervalMs?: number;
  };
  coverage?: {
    get(sessionId: string, signal?: AbortSignal): Promise<RecordingCoverage | undefined>;
    commit(
      lease: import('./monitor-recording-store.js').MonitorRecorderLease,
      value: SealedMonitorRecording,
      reference: StoredMonitorChunk,
      terminal: TerminalRecordingCheckpoint,
      now: string,
      signal?: AbortSignal,
    ): Promise<RecordingCoverage>;
    finish(
      lease: import('./monitor-recording-store.js').MonitorRecorderLease,
      coverage: RecordingCoverage,
      now: string,
      signal?: AbortSignal,
    ): Promise<void>;
  };
  captures?: {
    baseline(lease: import('./monitor-recording-store.js').MonitorRecorderLease, signal: AbortSignal): Promise<void>;
    collect(lease: import('./monitor-recording-store.js').MonitorRecorderLease, signal: AbortSignal): Promise<void>;
    finish(
      lease: import('./monitor-recording-store.js').MonitorRecorderLease,
      checkpoint: TerminalRecordingCheckpoint,
      cutoffAt: string,
      signal: AbortSignal,
    ): Promise<void>;
  };
  lifecycle?: {
    ready(
      lease: import('./monitor-recording-store.js').MonitorRecorderLease,
      startedAt: string,
      terminal: TerminalRecordingCheckpoint,
      signal: AbortSignal,
    ): Promise<void>;
    monitor(
      lease: import('./monitor-recording-store.js').MonitorRecorderLease,
      value: import('./monitor-recorder.js').MonitorRecordingBatch,
      signal?: AbortSignal,
    ): Promise<void>;
  };
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
  private readonly recordings: MonitorRecordingLeaseStore & MonitorRecordingStateStore & MonitorRecordingLifecycleStore;
  private readonly leaseDurationMs: number;
  private readonly renewalIntervalMs: number;
  private readonly pollIntervalMs: number | undefined;
  private readonly terminal: MonitorRecordingRunnerOptions['terminal'];
  private readonly lifecycle: MonitorRecordingRunnerOptions['lifecycle'];
  private readonly optionsCoverage: MonitorRecordingRunnerOptions['coverage'];
  private readonly captures: MonitorRecordingRunnerOptions['captures'];
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
    this.terminal = options.terminal;
    this.lifecycle = options.lifecycle;
    this.optionsCoverage = options.coverage;
    this.captures = options.captures;
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
    let terminalRecorder: TerminalRecorder | undefined;
    let terminalOpened = false;
    let terminalTask: Promise<void> | undefined;
    let terminalFailure: unknown;
    let terminalSealer: TerminalSealer | undefined;
    let savedTerminal: TerminalRecordingCheckpoint | undefined;
    const holdTerminalFailure = (error: unknown) => {
      terminalFailure = error;
      if (!(error instanceof TerminalRecorderError && ['data_gap', 'limit_exceeded'].includes(error.code))) {
        lifetime.abort(error);
        polling.abort(error);
      }
    };

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

      const coverage = await this.optionsCoverage?.get(this.sessionId, lifetime.signal);
      if (coverage) {
        if (
          !this.terminal ||
          !drain ||
          drain.cutoffAt !== coverage.cutoffAt ||
          drain.drainDeadlineAt !== coverage.sealingDeadlineAt
        )
          throw new MonitorRecordingRunnerError('invalid_state');
        this.client.close();
        await new TerminalSealer({
          lease: claimed.lease,
          pages: this.terminal.pages,
          seals: this.terminal.seals,
          now: this.now,
        }).seal(coverage.terminal, coverage.cutoffAt, lifetime.signal);
        stopRenewal.abort();
        await renewal;
        if (renewalFailure !== undefined) throw renewalFailure;
        await this.optionsCoverage!.finish(claimed.lease, coverage, this.now(), lifetime.signal);
        return { status: 'complete', generation };
      }

      await this.captures?.baseline(claimed.lease, lifetime.signal);
      if (this.terminal) {
        terminalRecorder = new TerminalRecorder({
          connect: this.terminal.connect,
          sink: new DurableTerminalRecordingSink({
            lease: claimed.lease,
            chunks: this.terminal.chunks,
            recordings: this.terminal.recordings,
            now: this.now,
            ...(this.captures
              ? {
                  afterCommit: (signal?: AbortSignal) =>
                    this.captures!.collect(claimed.lease, signal ?? lifetime.signal),
                }
              : {}),
          }),
          ...(this.terminal.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.terminal.pollIntervalMs }),
        });
        terminalSealer = new TerminalSealer({
          lease: claimed.lease,
          pages: this.terminal.pages,
          seals: this.terminal.seals,
          now: this.now,
        });
        savedTerminal = await this.terminal.recordings.get(this.sessionId, lifetime.signal);
        const savedSeal = await this.terminal.seals.get(this.sessionId, lifetime.signal);
        if (!(
          drain &&
          savedTerminal &&
          (savedSeal?.cutoffAt === drain.cutoffAt ||
            terminalCoversCutoff(savedTerminal, drain.cutoffAt) ||
            (savedTerminal.metadata.loss !== null && savedTerminal.metadata.loss.occurredAt <= drain.cutoffAt))
        )) {
          await terminalRecorder.begin(lifetime.signal);
          terminalOpened = true;
          if (this.lifecycle) await terminalRecorder.prime(lifetime.signal);
          if (!this.lifecycle) {
            terminalTask = terminalRecorder
              .record(lifetime.signal, () => drain?.cutoffAt ?? null)
              .then(() => {}, holdTerminalFailure);
          }
        }
      }

      const sink = new DurableMonitorRecordingSink({
        lease: claimed.lease,
        chunks: this.chunks,
        recordings: this.recordings,
        now: this.now,
        recordLifecycle: this.lifecycle !== undefined,
      });
      let sealedMonitor: { value: SealedMonitorRecording; reference: StoredMonitorChunk } | undefined;
      const recorder = new MonitorRecorder({
        client: this.client,
        sink: this.terminal
          ? {
              begin: (value, operationSignal) => sink.begin(value, operationSignal),
              append: async (value, operationSignal) => {
                await sink.append(value, operationSignal);
                await this.lifecycle?.monitor(claimed.lease, value, operationSignal);
              },
              seal: async (value, operationSignal) => {
                const reference = await this.chunks.putSealed(
                  this.sessionId,
                  claimed.lease.generation,
                  value,
                  operationSignal,
                );
                sealedMonitor = { value, reference };
              },
            }
          : sink,
        checkpoint: claimed.state,
        ...(this.pollIntervalMs === undefined ? {} : { pollIntervalMs: this.pollIntervalMs }),
      });

      const started = await recorder.begin(lifetime.signal);
      if (this.lifecycle && drain === null) {
        if (!terminalRecorder) throw new MonitorRecordingRunnerError('invalid_state');
        if (recorder.checkpoint.cursor === 0) await recorder.prime(lifetime.signal);
        await this.lifecycle.ready(claimed.lease, started.startedAt, terminalRecorder.checkpoint, lifetime.signal);
      }
      if (this.lifecycle && terminalOpened && terminalRecorder) {
        terminalTask = terminalRecorder
          .record(lifetime.signal, () => drain?.cutoffAt ?? null)
          .then(() => {}, holdTerminalFailure);
      }
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
      if (terminalFailure !== undefined && !(terminalFailure instanceof TerminalRecorderError)) throw terminalFailure;
      if (signal.aborted) return { status: 'cancelled', generation };
      if (lifetime.signal.aborted) throw lifetime.signal.reason;
      if (drain === null) throw new MonitorRecordingRunnerError('invalid_state');

      await recorder.seal(drain.cutoffAt, lifetime.signal);
      if (terminalSealer && terminalRecorder) {
        if (terminalTask) await terminalTask;
        const checkpoint = terminalTask ? terminalRecorder.checkpoint : savedTerminal!;
        const loss = checkpoint.metadata.loss;
        if (loss && loss.occurredAt <= drain.cutoffAt) {
          // Stop renewing before the atomic terminal-state write removes this lease.
          stopRenewal.abort();
          await renewal;
          terminalFailure = undefined;
          await this.recordings.markIncomplete(this.sessionId, loss.reason, this.now(), lifetime.signal, claimed.lease);
          return { status: 'incomplete', generation };
        }
        if (terminalFailure !== undefined) throw terminalFailure;
        if (lifetime.signal.aborted) throw lifetime.signal.reason;
        await this.captures?.finish(claimed.lease, checkpoint, drain.cutoffAt, lifetime.signal);
        if (!sealedMonitor) throw new MonitorRecordingRunnerError('invalid_state');
        const committedCoverage = await this.optionsCoverage?.commit(
          claimed.lease,
          sealedMonitor.value,
          sealedMonitor.reference,
          checkpoint,
          this.now(),
          lifetime.signal,
        );
        if (this.optionsCoverage) {
          terminalRecorder.close();
          this.client.close();
        }
        await terminalSealer.seal(checkpoint, drain.cutoffAt, lifetime.signal);
        stopRenewal.abort();
        await renewal;
        if (renewalFailure !== undefined) throw renewalFailure;
        if (this.optionsCoverage) {
          if (!committedCoverage) throw new MonitorRecordingRunnerError('invalid_state');
          await this.optionsCoverage.finish(claimed.lease, committedCoverage, this.now(), lifetime.signal);
        } else
          await this.recordings.seal(
            claimed.lease,
            sealedMonitor.value,
            sealedMonitor.reference,
            this.now(),
            lifetime.signal,
          );
      }
      return { status: 'complete', generation };
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled', generation };
      const failure = terminalFailure ?? error;
      if (
        isStoreError(failure, 'stale_lease') ||
        (failure instanceof TerminalRecordingStoreError && failure.code === 'stale_lease')
      ) {
        return { status: 'ownership_lost', generation };
      }
      if (renewalFailure !== undefined) {
        if (isStoreError(renewalFailure, 'stale_lease')) {
          return { status: 'ownership_lost', generation };
        }
        throw renewalFailure;
      }
      throw failure;
    } finally {
      stopRenewal?.abort();
      polling.abort();
      lifetime.abort();
      if (renewal !== undefined) await renewal;
      if (terminalTask !== undefined) await terminalTask;
      terminalRecorder?.close();
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
