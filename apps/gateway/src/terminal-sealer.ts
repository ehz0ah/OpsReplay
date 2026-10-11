import type { TerminalRecordingCheckpoint } from '../../../packages/contracts/private/terminal-persistence.js';
import type { TerminalSealState } from '../../../packages/contracts/private/terminal-sealing.js';
import type { MonitorRecorderLease } from './monitor-recording-store.js';
import type { TerminalPageArchive } from './terminal-page-archive.js';
import type { TerminalSealingStore } from './terminal-sealing-store.js';
import { TerminalRecordingStoreError } from './terminal-recording-store.js';

export interface TerminalSealerOptions {
  lease: MonitorRecorderLease;
  pages: TerminalPageArchive;
  seals: TerminalSealingStore;
  now?: () => string;
}

/** Seals the committed prefix using at most one source page in memory. */
export class TerminalSealer {
  private readonly lease: MonitorRecorderLease;
  private readonly now: () => string;
  constructor(private readonly options: TerminalSealerOptions) {
    this.lease = { ...options.lease };
    this.now = options.now ?? (() => new Date().toISOString());
  }
  async seal(
    checkpoint: TerminalRecordingCheckpoint,
    cutoffAt: string,
    signal?: AbortSignal,
  ): Promise<TerminalSealState> {
    let state = await this.options.seals.begin(this.lease, structuredClone(checkpoint), cutoffAt, this.now(), signal);
    while (!state.complete) {
      signal?.throwIfAborted();
      if (state.cursor === state.checkpoint.cursor)
        return this.options.seals.finish(this.lease, state, null, this.now(), signal);
      const reference = await this.options.seals.nextPage(
        this.lease.sessionId,
        state.checkpoint.metadata.source,
        state.cursor,
        signal,
      );
      if (!reference || reference.nextSequence > state.checkpoint.cursor)
        throw new TerminalRecordingStoreError('invalid_store');
      const page = await this.options.pages.readLive(this.lease.sessionId, reference, signal);
      const remaining = page.events.filter((event) => event.sequence > state.cursor);
      const firstExcluded = remaining.findIndex((event) => event.recordedAt > cutoffAt);
      const events = firstExcluded < 0 ? remaining : remaining.slice(0, firstExcluded);
      if (events.length > 0) {
        const sealed = await this.options.pages.putSealed(
          this.lease.sessionId,
          this.lease.generation,
          page.source,
          state.cursor,
          events,
          signal,
        );
        signal?.throwIfAborted();
        state = await this.options.seals.append(
          this.lease,
          state,
          sealed,
          events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0),
          this.now(),
          events,
          signal,
        );
      }
      if (firstExcluded >= 0)
        return this.options.seals.finish(this.lease, state, { reference, page }, this.now(), signal);
    }
    return state;
  }
}
