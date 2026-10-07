import { setTimeout as delay } from 'node:timers/promises';
import {
  isMonitorControlSource,
  isMonitorControlTimestamp,
  monitorControlSchema,
} from '../../../packages/contracts/private/monitor-control.js';
import type { MonitorFrame, MonitorFramePage, MonitorMetricFrame, MonitorSealResult } from './monitor-client.js';
import { MonitorClientError } from './monitor-client.js';

export interface MonitorRecordingCheckpoint {
  startedAt: string | null;
  source: string | null;
  cursor: number;
}

export interface MonitorRecordingStart {
  startedAt: string;
}

export interface MonitorRecordingBatch {
  startedAt: string;
  source: string;
  after: number;
  nextSequence: number;
  frames: readonly MonitorFrame[];
}

export interface SealedMonitorRecording {
  startedAt: string;
  cutoffAt: string;
  source: string | null;
  cursor: number;
  frames: readonly MonitorFrame[];
  final: MonitorMetricFrame;
}

/**
 * Each operation must be durable and idempotent before it resolves. A repeated batch is
 * identified by its source and sequence range. Seal replaces provisional data with the
 * canonical stream returned after the monitor accepts the lifecycle cutoff.
 */
export interface MonitorRecordingSink {
  begin(value: MonitorRecordingStart, signal?: AbortSignal): Promise<void>;
  append(value: MonitorRecordingBatch, signal?: AbortSignal): Promise<void>;
  seal(value: SealedMonitorRecording, signal?: AbortSignal): Promise<void>;
}

export interface MonitorRecordingClient {
  start(signal?: AbortSignal): Promise<{ startedAt: string }>;
  read(after: number, expectedSource?: string, signal?: AbortSignal): Promise<MonitorFramePage>;
  seal(cutoffAt: string, signal?: AbortSignal): Promise<MonitorSealResult>;
}

export interface MonitorRecorderOptions {
  client: MonitorRecordingClient;
  sink: MonitorRecordingSink;
  checkpoint?: MonitorRecordingCheckpoint;
  pollIntervalMs?: number;
  maximumFrames?: number;
}

export type MonitorRecorderErrorCode = 'invalid_config' | 'invalid_state' | 'invalid_stream' | 'recording_limit';

const messages: Record<MonitorRecorderErrorCode, string> = {
  invalid_config: 'Monitor recorder configuration is invalid.',
  invalid_state: 'Monitor recorder state does not permit this operation.',
  invalid_stream: 'Monitor recording stream is invalid.',
  recording_limit: 'Monitor recording frame limit was exceeded.',
};

export class MonitorRecorderError extends Error {
  constructor(readonly code: MonitorRecorderErrorCode) {
    super(messages[code]);
    this.name = 'MonitorRecorderError';
  }
}

const defaultPollIntervalMs = 500;
const maximumPollIntervalMs = 5_000;
const minimumPollIntervalMs = 50;
const defaultMaximumFrames = 10_000;

function validCheckpoint(value: MonitorRecordingCheckpoint, maximumFrames: number): boolean {
  if (
    !Number.isInteger(value.cursor) ||
    value.cursor < 0 ||
    value.cursor > maximumFrames ||
    value.cursor > monitorControlSchema.maximumCursor ||
    (value.startedAt !== null && !isMonitorControlTimestamp(value.startedAt)) ||
    (value.source !== null && !isMonitorControlSource(value.source))
  ) {
    return false;
  }
  if (value.startedAt === null) return value.source === null && value.cursor === 0;
  return value.cursor === 0 ? value.source === null : value.source !== null;
}

function cloneCheckpoint(value: MonitorRecordingCheckpoint): MonitorRecordingCheckpoint {
  return { ...value };
}

function cancelled(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    ((error instanceof Error && error.name === 'AbortError') ||
      (error instanceof MonitorClientError && error.code === 'cancelled'))
  );
}

export class MonitorRecorder {
  private readonly client: MonitorRecordingClient;
  private readonly sink: MonitorRecordingSink;
  private readonly pollIntervalMs: number;
  private readonly maximumFrames: number;
  private current: MonitorRecordingCheckpoint;
  private beginning = false;
  private running = false;
  private sealing = false;
  private sealed = false;

  constructor(options: MonitorRecorderOptions) {
    const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
    const maximumFrames = options.maximumFrames ?? defaultMaximumFrames;
    const checkpoint = options.checkpoint ?? { startedAt: null, source: null, cursor: 0 };
    if (
      !Number.isInteger(pollIntervalMs) ||
      pollIntervalMs < minimumPollIntervalMs ||
      pollIntervalMs > maximumPollIntervalMs ||
      !Number.isInteger(maximumFrames) ||
      maximumFrames < 1 ||
      maximumFrames > defaultMaximumFrames ||
      !validCheckpoint(checkpoint, maximumFrames)
    ) {
      throw new MonitorRecorderError('invalid_config');
    }
    this.client = options.client;
    this.sink = options.sink;
    this.pollIntervalMs = pollIntervalMs;
    this.maximumFrames = maximumFrames;
    this.current = cloneCheckpoint(checkpoint);
  }

  get checkpoint(): MonitorRecordingCheckpoint {
    return cloneCheckpoint(this.current);
  }

  async begin(signal?: AbortSignal): Promise<MonitorRecordingStart> {
    if (this.beginning || this.running || this.sealing || this.sealed) {
      throw new MonitorRecorderError('invalid_state');
    }
    this.beginning = true;
    try {
      const started = await this.client.start(signal);
      if (!isMonitorControlTimestamp(started.startedAt)) throw new MonitorRecorderError('invalid_stream');
      if (this.current.startedAt !== null) {
        if (started.startedAt !== this.current.startedAt) throw new MonitorRecorderError('invalid_stream');
        return { ...started };
      }
      await this.sink.begin({ startedAt: started.startedAt }, signal);
      this.current = { startedAt: started.startedAt, source: null, cursor: 0 };
      return { ...started };
    } finally {
      this.beginning = false;
    }
  }

  async record(signal: AbortSignal): Promise<MonitorRecordingCheckpoint> {
    if (this.current.startedAt === null || this.running || this.sealing || this.sealed) {
      throw new MonitorRecorderError('invalid_state');
    }
    if (signal.aborted) return this.checkpoint;
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          const fullPage = await this.pull(signal);
          if (!signal.aborted) {
            await delay(fullPage ? minimumPollIntervalMs : this.pollIntervalMs, undefined, { signal });
          }
        } catch (error) {
          if (cancelled(error, signal)) break;
          throw error;
        }
      }
      return this.checkpoint;
    } finally {
      this.running = false;
    }
  }

  async seal(cutoffAt: string, signal?: AbortSignal): Promise<SealedMonitorRecording> {
    const startedAt = this.current.startedAt;
    if (!isMonitorControlTimestamp(cutoffAt)) throw new MonitorRecorderError('invalid_config');
    if (
      startedAt === null ||
      this.beginning ||
      this.running ||
      this.sealing ||
      this.sealed ||
      Date.parse(cutoffAt) < Date.parse(startedAt)
    ) {
      throw new MonitorRecorderError('invalid_state');
    }
    this.sealing = true;
    try {
      const result = await this.client.seal(cutoffAt, signal);
      if (result.final.sample.at !== cutoffAt) throw new MonitorRecorderError('invalid_stream');
      const canonical = await this.readSealed(cutoffAt, signal);
      const recording: SealedMonitorRecording = {
        startedAt,
        cutoffAt,
        source: canonical.source,
        cursor: canonical.cursor,
        frames: canonical.frames,
        final: structuredClone(result.final),
      };
      await this.sink.seal(structuredClone(recording), signal);
      this.current = { startedAt, source: recording.source, cursor: recording.cursor };
      this.sealed = true;
      return structuredClone(recording);
    } finally {
      this.sealing = false;
    }
  }

  private async pull(signal: AbortSignal): Promise<boolean> {
    const startedAt = this.current.startedAt!;
    const page = await this.client.read(this.current.cursor, this.current.source ?? undefined, signal);
    if (page.sealed) throw new MonitorRecorderError('invalid_stream');
    if (page.nextSequence > this.maximumFrames) throw new MonitorRecorderError('recording_limit');
    if (page.frames.length === 0) return false;
    if (page.frames.some((frame) => Date.parse(frame.recordedAt) < Date.parse(startedAt))) {
      throw new MonitorRecorderError('invalid_stream');
    }
    const source = page.frames[0]!.source;
    const batch: MonitorRecordingBatch = {
      startedAt,
      source,
      after: this.current.cursor,
      nextSequence: page.nextSequence,
      frames: structuredClone(page.frames),
    };
    await this.sink.append(batch, signal);
    this.current = { startedAt, source, cursor: page.nextSequence };
    return page.frames.length === monitorControlSchema.maximumFramesPerPage;
  }

  private async readSealed(
    cutoffAt: string,
    signal?: AbortSignal,
  ): Promise<{ source: string | null; cursor: number; frames: MonitorFrame[] }> {
    const frames: MonitorFrame[] = [];
    let cursor = 0;
    let source = this.current.source;
    while (true) {
      const page = await this.client.read(cursor, source ?? undefined, signal);
      if (!page.sealed) throw new MonitorRecorderError('invalid_stream');
      if (page.nextSequence > this.maximumFrames) throw new MonitorRecorderError('recording_limit');
      for (const frame of page.frames) {
        const recordedAt = Date.parse(frame.recordedAt);
        if (recordedAt < Date.parse(this.current.startedAt!) || recordedAt > Date.parse(cutoffAt)) {
          throw new MonitorRecorderError('invalid_stream');
        }
        source ??= frame.source;
        frames.push(structuredClone(frame));
      }
      cursor = page.nextSequence;
      if (page.frames.length === 0) break;
      await delay(minimumPollIntervalMs, undefined, signal === undefined ? undefined : { signal });
    }
    if (this.current.cursor > 0 && cursor === 0) throw new MonitorRecorderError('invalid_stream');
    return { source, cursor, frames };
  }
}
