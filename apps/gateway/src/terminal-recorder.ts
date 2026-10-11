import { setTimeout as delay } from 'node:timers/promises';
import type { TerminalRecordingCheckpoint } from '../../../packages/contracts/private/terminal-persistence.js';
import type {
  TerminalRecordingPage,
  TerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.js';
import { isMonitorControlTimestamp } from '../../../packages/contracts/private/monitor-control.js';
import { terminalCoversCutoff } from '../../../packages/contracts/private/terminal-sealing.js';
import type { DurableTerminalRecordingSink } from './terminal-recording-sink.js';
import { TerminalRecordingClientError } from './terminal-recording-client.js';

export interface ClosableTerminalRecordingClient {
  read(after: number, signal?: AbortSignal): Promise<TerminalRecordingPage>;
  close(): void;
}
export interface TerminalRecordingConnection {
  ready: TerminalRecordingReady;
  client: ClosableTerminalRecordingClient;
}
export interface TerminalRecorderOptions {
  connect(signal: AbortSignal): Promise<TerminalRecordingConnection>;
  sink: Pick<DurableTerminalRecordingSink, 'begin' | 'append'>;
  pollIntervalMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
export class TerminalRecorderError extends Error {
  constructor(readonly code: 'invalid_config' | 'invalid_state' | 'data_gap' | 'limit_exceeded') {
    super('Terminal recording collection failed.');
    this.name = 'TerminalRecorderError';
  }
}

export { terminalCoversCutoff } from '../../../packages/contracts/private/terminal-sealing.js';

/** Collects source pages only. The existing runner owns and renews the lease. */
export class TerminalRecorder {
  private readonly interval: number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private connection: TerminalRecordingConnection | undefined;
  private current: TerminalRecordingCheckpoint | undefined;
  private used = false;
  constructor(private readonly options: TerminalRecorderOptions) {
    this.interval = options.pollIntervalMs ?? 500;
    if (!Number.isInteger(this.interval) || this.interval < 100 || this.interval > 5_000)
      throw new TerminalRecorderError('invalid_config');
    this.wait = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
  }
  get checkpoint(): TerminalRecordingCheckpoint {
    if (!this.current) throw new TerminalRecorderError('invalid_state');
    return structuredClone(this.current);
  }
  async begin(signal: AbortSignal): Promise<void> {
    if (this.used) throw new TerminalRecorderError('invalid_state');
    this.used = true;
    try {
      this.connection = await this.options.connect(signal);
      this.current = await this.options.sink.begin(this.connection.ready, signal);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async record(signal: AbortSignal, cutoff: () => string | null): Promise<TerminalRecordingCheckpoint> {
    if (!this.connection || !this.current) throw new TerminalRecorderError('invalid_state');
    while (!signal.aborted) {
      const end = cutoff();
      if (end !== null && !isMonitorControlTimestamp(end)) throw new TerminalRecorderError('invalid_state');
      const loss = this.current.metadata.loss;
      if (loss && (end === null || loss.occurredAt <= end)) throw new TerminalRecorderError(loss.reason);
      if (end !== null && terminalCoversCutoff(this.current, end)) return this.checkpoint;
      try {
        if (this.current.frontier?.type === 'exit' && this.current.cursor === this.current.metadata.latestSequence) {
          this.connection.client.close();
          await this.wait(this.interval, signal);
          continue;
        }
        const page = await this.connection.client.read(this.current.cursor, signal);
        this.current = await this.options.sink.append(this.current, page, signal);
        await this.wait(page.events.length > 0 ? 100 : this.interval, signal);
      } catch (error) {
        if (
          signal.aborted &&
          ((error instanceof Error && error.name === 'AbortError') ||
            (error instanceof TerminalRecordingClientError && error.code === 'cancelled'))
        )
          break;
        throw error;
      }
    }
    return this.checkpoint;
  }
  close(): void {
    this.connection?.client.close();
  }
}
