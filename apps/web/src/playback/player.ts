import { pause } from '../lifecycle.js';
import type { PlaybackRange } from './terminal.js';
export const playbackSpeeds = [0.5, 1, 2, 4] as const;
export type PlaybackStatus = 'paused' | 'playing' | 'seeking' | 'ended' | 'error';
export interface PlayerState {
  at: number;
  speed: number;
  status: PlaybackStatus;
  error: Error | null;
}
interface PlaybackClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
/** One cancellable clock. Rendering is serialized so old writes finish before a new seek resets the screen. */
export class PlaybackPlayer {
  private state: PlayerState;
  private controller = new AbortController();
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private clockAt: number;
  private wallAt = 0;
  private ticking = false;
  constructor(
    readonly range: PlaybackRange,
    private readonly render: (at: number, signal: AbortSignal) => Promise<void>,
    private readonly observe: (state: PlayerState) => void,
    private readonly clock: PlaybackClock = { now: () => performance.now(), wait: pause },
    initial = range.start,
    speed = 1,
  ) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end < range.start)
      throw new Error('Invalid playback range.');
    this.state = { at: this.clamp(initial), speed: 1, status: 'paused', error: null };
    this.clockAt = this.state.at;
    this.setSpeed(speed);
  }
  private clamp(at: number) {
    if (!Number.isFinite(at)) throw new Error('Invalid playback position.');
    return Math.max(this.range.start, Math.min(this.range.end, at));
  }
  private emit(update: Partial<PlayerState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    this.observe({ ...this.state });
  }
  private advance() {
    const now = this.clock.now();
    this.clockAt = this.clamp(this.clockAt + Math.max(0, now - this.wallAt) * this.state.speed);
    this.wallAt = now;
    return this.clockAt;
  }
  private run(status: PlaybackStatus, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.controller.abort();
    this.ticking = false;
    const controller = (this.controller = new AbortController()),
      generation = ++this.generation;
    this.emit({ status, error: null });
    const operation = this.tail.then(async () => {
      if (controller.signal.aborted || generation !== this.generation) return;
      try {
        await action(controller.signal);
      } catch (value) {
        if (!controller.signal.aborted) {
          // Asset readers provide safe errors without signed links or private data.
          this.emit({ status: 'error', error: value instanceof Error ? value : new Error('Playback failed.') });
        }
      }
    });
    this.tail = operation;
    return operation;
  }
  seek(at: number): Promise<void> {
    const target = this.clamp(at);
    this.clockAt = target;
    return this.run('seeking', async (signal) => {
      await this.render(target, signal);
      signal.throwIfAborted();
      this.emit({ at: target, status: 'paused' });
    });
  }
  play(): Promise<void> {
    const start = this.clockAt >= this.range.end ? this.range.start : this.clockAt;
    this.clockAt = start;
    this.wallAt = this.clock.now();
    return this.run('playing', async (signal) => {
      await this.render(start, signal);
      signal.throwIfAborted();
      this.emit({ at: start });
      this.wallAt = this.clock.now();
      this.clockAt = start;
      this.ticking = true;
      while (!signal.aborted) {
        const at = this.advance();
        this.ticking = false;
        await this.render(at, signal);
        signal.throwIfAborted();
        this.emit({ at });
        if (at >= this.range.end) {
          this.emit({ status: 'ended' });
          return;
        }
        this.wallAt = this.clock.now();
        this.ticking = true;
        await this.clock.wait(50, signal);
      }
    });
  }
  pause(): Promise<void> {
    const at = this.ticking ? this.advance() : this.clockAt;
    return this.seek(at);
  }
  setSpeed(speed: number) {
    if (!(playbackSpeeds as readonly number[]).includes(speed)) throw new Error('Invalid playback speed.');
    if (this.ticking) this.advance();
    this.emit({ speed });
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.controller.abort();
  }
}
