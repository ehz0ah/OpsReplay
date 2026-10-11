import {
  advanceTerminalCheckpoint,
  type TerminalRecordingCheckpoint,
} from '../../../packages/contracts/private/terminal-persistence.js';
import type {
  TerminalRecordingPage,
  TerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.js';
import type { TerminalChunkStore } from './terminal-chunk-store.js';
import type { MonitorRecorderLease } from './monitor-recording-store.js';
import { TerminalRecordingStoreError, type TerminalRecordingStateStore } from './terminal-recording-store.js';

export interface DurableTerminalRecordingSinkOptions {
  lease: MonitorRecorderLease;
  chunks: TerminalChunkStore;
  recordings: TerminalRecordingStateStore;
  now?: () => string;
  afterCommit?: (signal?: AbortSignal) => Promise<void>;
}

/** No in-memory cursor advancement: the caller receives a checkpoint only after commit. */
export class DurableTerminalRecordingSink {
  private readonly lease: MonitorRecorderLease;
  private readonly now: () => string;
  constructor(private readonly options: DurableTerminalRecordingSinkOptions) {
    this.lease = { ...options.lease };
    this.now = options.now ?? (() => new Date().toISOString());
  }
  begin(ready: TerminalRecordingReady, signal?: AbortSignal): Promise<TerminalRecordingCheckpoint> {
    return this.options.recordings.begin(this.lease, structuredClone(ready), this.now(), signal);
  }
  async append(
    previous: TerminalRecordingCheckpoint,
    value: TerminalRecordingPage,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingCheckpoint> {
    const checkpoint = structuredClone(previous);
    const page = structuredClone(value);
    try {
      advanceTerminalCheckpoint(checkpoint, page);
    } catch {
      throw new TerminalRecordingStoreError('invalid_stream');
    }
    signal?.throwIfAborted();
    const reference =
      page.events.length === 0
        ? null
        : await this.options.chunks.putPage(
            this.lease.sessionId,
            this.lease.generation,
            checkpoint.cursor,
            page,
            signal,
          );
    signal?.throwIfAborted();
    const committed = await this.options.recordings.commit(this.lease, checkpoint, page, reference, this.now(), signal);
    await this.options.afterCommit?.(signal);
    return committed;
  }
}
