import { setTimeout as delay } from 'node:timers/promises';
import { MonitorChunkStoreError } from './monitor-chunk-store.js';
import { MonitorClientError } from './monitor-client.js';
import { MonitorRecorderError } from './monitor-recorder.js';
import { MonitorRecordingRunnerError, type MonitorRecordingRunResult } from './monitor-recording-runner.js';
import { MonitorRecordingStoreError } from './monitor-recording-store.js';
import { RecordingWorkSourceError, type RecordingWork, type RecordingWorkSource } from './recording-work-source.js';

export interface RecordingSessionRunner {
  run(signal: AbortSignal): Promise<MonitorRecordingRunResult>;
}

export type RecordingSessionRunnerFactory = (work: RecordingWork) => RecordingSessionRunner;

export type MonitorRecordingSupervisorEvent =
  | { type: 'runner_started'; sessionId: string }
  | {
      type: 'runner_finished';
      sessionId: string;
      status: MonitorRecordingRunResult['status'];
      generation: number | null;
    }
  | { type: 'runner_failed'; sessionId: string; error: { name: string; code: string | null } }
  | { type: 'retire_failed'; sessionId: string; error: { name: string; code: string | null } }
  | { type: 'source_invalid'; invalidEntries: number }
  | { type: 'source_failed'; error: { name: string; code: string | null } };

export interface MonitorRecordingSupervisorOptions {
  source: RecordingWorkSource;
  createRunner: RecordingSessionRunnerFactory;
  maximumConcurrentRecordings: number;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  report?: (event: MonitorRecordingSupervisorEvent) => void;
}

export type MonitorRecordingSupervisorErrorCode = 'invalid_config' | 'invalid_state';

const messages: Record<MonitorRecordingSupervisorErrorCode, string> = {
  invalid_config: 'Monitor recording supervisor configuration is invalid.',
  invalid_state: 'Monitor recording supervisor is already running or has stopped.',
};

export class MonitorRecordingSupervisorError extends Error {
  constructor(readonly code: MonitorRecordingSupervisorErrorCode) {
    super(messages[code]);
    this.name = 'MonitorRecordingSupervisorError';
  }
}

const defaultPollIntervalMs = 2_000;
const maximumPollIntervalMs = 30_000;
const maximumConcurrentRecordings = 64;

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return delay(milliseconds, undefined, { signal });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function description(error: unknown): { name: string; code: string | null } {
  const name = error instanceof Error && /^[A-Za-z0-9_.-]{1,128}$/.test(error.name) ? error.name : 'Error';
  const code =
    record(error) && typeof error.code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(error.code) ? error.code : null;
  return { name, code };
}

function expectedCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && ['AbortError', 'MonitorClientError'].includes(error.name);
}

const transientAwsNames = new Set([
  'InternalServerError',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailable',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
]);
const transientNetworkCodes = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

function transientAwsFailure(error: unknown): boolean {
  if (!record(error)) return false;
  const metadata = record(error.$metadata) ? error.$metadata : undefined;
  const retryable = record(error.$retryable) ? error.$retryable : undefined;
  const status = metadata?.httpStatusCode;
  const name = typeof error.name === 'string' ? error.name : '';
  const code = typeof error.code === 'string' ? error.code : '';
  return (
    retryable?.throttling === true ||
    transientAwsNames.has(name) ||
    transientAwsNames.has(code) ||
    transientNetworkCodes.has(code) ||
    error.$fault === 'server' ||
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500)
  );
}

function operationalFailure(error: unknown): boolean {
  if (error instanceof MonitorClientError) return error.code !== 'invalid_config';
  if (error instanceof MonitorRecordingStoreError) {
    return !['invalid_config', 'invalid_input'].includes(error.code);
  }
  if (error instanceof MonitorChunkStoreError) return error.code === 'chunk_too_large';
  if (error instanceof MonitorRecorderError) return ['invalid_stream', 'recording_limit'].includes(error.code);
  if (error instanceof RecordingWorkSourceError) return ['invalid_store', 'unavailable'].includes(error.code);
  if (error instanceof MonitorRecordingRunnerError) return false;
  if (transientAwsFailure(error)) return true;
  return error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
}

export class MonitorRecordingSupervisor {
  private readonly source: RecordingWorkSource;
  private readonly createRunner: RecordingSessionRunnerFactory;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly report: (event: MonitorRecordingSupervisorEvent) => void;
  private used = false;

  constructor(options: MonitorRecordingSupervisorOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    const retryDelayMs = options.retryDelayMs ?? pollIntervalMs;
    if (
      !Number.isInteger(options.maximumConcurrentRecordings) ||
      options.maximumConcurrentRecordings < 1 ||
      options.maximumConcurrentRecordings > maximumConcurrentRecordings ||
      !Number.isInteger(pollIntervalMs) ||
      pollIntervalMs < 100 ||
      pollIntervalMs > maximumPollIntervalMs ||
      !Number.isInteger(retryDelayMs) ||
      retryDelayMs < pollIntervalMs ||
      retryDelayMs > maximumPollIntervalMs
    ) {
      throw new MonitorRecordingSupervisorError('invalid_config');
    }
    this.source = options.source;
    this.createRunner = options.createRunner;
    this.concurrency = options.maximumConcurrentRecordings;
    this.pollIntervalMs = pollIntervalMs;
    this.retryDelayMs = retryDelayMs;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? defaultWait;
    this.report = options.report ?? (() => {});
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.used) throw new MonitorRecordingSupervisorError('invalid_state');
    this.used = true;
    const lifetime = new AbortController();
    const cancel = () => lifetime.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();

    const active = new Map<string, Promise<void>>();
    const retryAfter = new Map<string, number>();
    let discoveryPausedUntil = 0;
    let fatal: unknown;

    const fail = (error: unknown): void => {
      if (fatal === undefined) fatal = error;
    };

    const retry = (sessionId: string): void => {
      const retryAt = this.now() + this.retryDelayMs;
      retryAfter.delete(sessionId);
      if (retryAfter.size < this.concurrency) retryAfter.set(sessionId, retryAt);
      else discoveryPausedUntil = Math.max(discoveryPausedUntil, retryAt);
    };

    const launch = (work: RecordingWork): void => {
      if (
        fatal !== undefined ||
        lifetime.signal.aborted ||
        active.has(work.sessionId) ||
        active.size >= this.concurrency
      ) {
        return;
      }
      let runner: RecordingSessionRunner;
      try {
        runner = this.createRunner(work);
      } catch (error) {
        fail(error);
        return;
      }
      this.safeReport({ type: 'runner_started', sessionId: work.sessionId });
      let task: Promise<void>;
      task = this.runOne(work, runner, lifetime.signal, retry, fail).finally(() => {
        if (active.get(work.sessionId) === task) active.delete(work.sessionId);
      });
      active.set(work.sessionId, task);
    };

    try {
      while (!lifetime.signal.aborted && fatal === undefined) {
        const now = this.now();
        for (const [sessionId, retryAt] of retryAfter) {
          if (retryAt <= now) retryAfter.delete(sessionId);
        }
        const available = this.concurrency - active.size;
        if (available > 0 && now >= discoveryPausedUntil) {
          try {
            const discovery = await this.source.discover(
              {
                limit: available,
                excludedSessionIds: [...active.keys(), ...retryAfter.keys()],
                now: new Date(now).toISOString(),
              },
              lifetime.signal,
            );
            if (discovery.invalidEntries > 0) {
              this.safeReport({ type: 'source_invalid', invalidEntries: discovery.invalidEntries });
            }
            for (const item of discovery.work) launch(item);
          } catch (error) {
            if (!expectedCancellation(error, lifetime.signal)) {
              if (operationalFailure(error)) this.safeReport({ type: 'source_failed', error: description(error) });
              else fail(error);
            }
          }
        }
        if (fatal !== undefined) break;
        if (lifetime.signal.aborted) break;
        try {
          await Promise.race([
            this.wait(this.pollIntervalMs, lifetime.signal),
            ...[...active.values()].map(async (task) => task),
          ]);
        } catch (error) {
          if (!expectedCancellation(error, lifetime.signal)) throw error;
        }
      }
      if (fatal !== undefined) await Promise.all(active.values());
    } finally {
      lifetime.abort();
      await Promise.all(active.values());
      signal.removeEventListener('abort', cancel);
    }
    if (fatal !== undefined) throw fatal;
  }

  private async runOne(
    work: RecordingWork,
    runner: RecordingSessionRunner,
    signal: AbortSignal,
    retry: (sessionId: string) => void,
    fail: (error: unknown) => void,
  ): Promise<void> {
    try {
      const result = await runner.run(signal);
      this.safeReport({ type: 'runner_finished', sessionId: work.sessionId, ...result });
      if (result.status === 'complete' || result.status === 'not_recordable') {
        try {
          const retirement = await this.source.retire(work, signal);
          if (retirement === 'not_terminal') retry(work.sessionId);
        } catch (error) {
          if (expectedCancellation(error, signal)) return;
          if (!operationalFailure(error)) {
            fail(error);
            return;
          }
          this.safeReport({ type: 'retire_failed', sessionId: work.sessionId, error: description(error) });
          retry(work.sessionId);
        }
        return;
      }
      if (result.status !== 'cancelled') retry(work.sessionId);
    } catch (error) {
      if (expectedCancellation(error, signal)) return;
      if (!operationalFailure(error)) {
        fail(error);
        return;
      }
      this.safeReport({ type: 'runner_failed', sessionId: work.sessionId, error: description(error) });
      retry(work.sessionId);
    }
  }

  private safeReport(event: MonitorRecordingSupervisorEvent): void {
    try {
      this.report(event);
    } catch {
      /* Reporting must not change recording state. */
    }
  }
}
