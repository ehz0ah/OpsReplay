import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { parseCast, readAsset } from './assets.js';

export interface PlaybackRange {
  start: number;
  end: number;
}
export interface TerminalSink {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(value: string): Promise<void>;
}
export function terminalRange(tracks: PublicTypes['PlaybackTrack'][]): PlaybackRange | null {
  let start: number | null = null,
    end = 0;
  for (const track of tracks) {
    const from = Date.parse(track.startedAt),
      to = Date.parse(track.endedAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || (start !== null && from < end))
      throw new Error('Invalid terminal recording order.');
    start ??= from;
    end = to;
  }
  return start === null ? null : { start, end };
}

/** Reads saved output only. Input and marker events never execute. */
export class TerminalRecording {
  private track = 0;
  private event = 0;
  private through = -Infinity;
  private valid = false;
  private cache = new Map<number, ReturnType<typeof parseCast>>();
  readonly range: PlaybackRange | null;
  constructor(
    private readonly tracks: PublicTypes['PlaybackTrack'][],
    private readonly sink: TerminalSink,
    private readonly read = readAsset,
  ) {
    this.range = terminalRange(tracks);
  }
  async render(at: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!Number.isFinite(at)) throw new Error('Invalid playback position.');
    try {
      if (!this.valid || at < this.through) {
        this.sink.reset();
        this.track = 0;
        this.event = 0;
        this.through = -Infinity;
      }
      while (this.track < this.tracks.length) {
        signal.throwIfAborted();
        const track = this.tracks[this.track]!;
        if (Date.parse(track.startedAt) > at) break;
        let cast = this.cache.get(this.track);
        if (!cast) {
          cast = parseCast(await this.read(track.url, signal, 256 * 1024), track);
          signal.throwIfAborted();
          // Cache at most 32 bounded chunks, rather than the whole recording.
          if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(this.track, cast);
        }
        if (this.track === 0 && this.event === 0) this.sink.resize(cast.width, cast.height);
        while (this.event < cast.events.length) {
          const event = cast.events[this.event]!;
          if (event.at > at) break;
          signal.throwIfAborted();
          if (event.type === 'o') await this.sink.write(event.value);
          else if (event.type === 'r') {
            const [cols, rows] = event.value.split('x').map(Number);
            this.sink.resize(cols!, rows!);
          }
          signal.throwIfAborted();
          this.event++;
        }
        if (this.event < cast.events.length || Date.parse(track.endedAt) > at) break;
        this.track++;
        this.event = 0;
      }
      signal.throwIfAborted();
      this.through = at;
      this.valid = true;
    } catch (error) {
      // A cancelled write can still have reached the emulator. Reconstruct on the next operation.
      this.valid = false;
      throw error;
    }
  }
}
