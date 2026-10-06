import type { MetricFrame, PublicFrame } from './types.js';
import { MonitorError, limits } from './types.js';
import type { Frame } from './monitor.js';

export type ControlHealth = 'starting' | 'ready' | 'failed';
export interface ControlFrame {
  source: string;
  sequence: number;
  recordedAt: string;
  payload: PublicFrame;
}
export interface FramePage {
  frames: ControlFrame[];
  nextSequence: number;
  sealed: boolean;
}
export interface SealResult {
  cutoffAt: string;
  final: MetricFrame;
}

interface ControlledMonitor {
  readonly failure: MonitorError['code'] | null;
  now(): number;
  verifyInitialState(): Promise<boolean>;
  start(): number;
  tick(): void;
  read(after?: number, limit?: number): Frame[];
  seal(at?: number): Promise<MetricFrame>;
  fail(code: MonitorError['code']): void;
  drain(): Promise<void>;
}
interface Timer {
  close(): void;
}
export interface ControlScheduler {
  every(callback: () => void, intervalMs: number): Timer;
}
const scheduler: ControlScheduler = {
  every(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    return { close: () => clearInterval(timer) };
  },
};
const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseCutoffAt(value: string): number {
  const parsed = Date.parse(value);
  if (!canonicalTimestamp.test(value) || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) throw new MonitorError('invalid_boundary');
  return parsed;
}

export class MonitorControl {
  private healthState: ControlHealth = 'starting';
  private initialising: Promise<void> | undefined;
  private timer: Timer | undefined;
  private startedAt: number | undefined;
  private sealedAt: number | undefined;
  private sealing: Promise<SealResult> | undefined;
  private sealed = false;

  constructor(private readonly monitor: ControlledMonitor, private readonly ticks: ControlScheduler = scheduler) {}

  health(): ControlHealth { return this.monitor.failure ? 'failed' : this.healthState; }

  initialise(): Promise<void> {
    if (this.initialising) return this.initialising;
    this.initialising = this.monitor.verifyInitialState().then(ready => {
      this.healthState = ready ? 'ready' : 'failed';
    }).catch(() => { this.healthState = 'failed'; });
    return this.initialising;
  }

  start(): { startedAt: string } {
    if (this.healthState !== 'ready' || this.sealedAt !== undefined) throw new MonitorError('invalid_boundary');
    if (this.startedAt === undefined) {
      this.startedAt = this.monitor.start();
      this.monitor.tick();
      this.timer = this.ticks.every(() => this.monitor.tick(), 25);
    }
    return { startedAt: new Date(this.startedAt).toISOString() };
  }

  read(after: number): FramePage {
    if (this.startedAt === undefined) throw new MonitorError('invalid_boundary');
    const frames = this.monitor.read(after, limits.controlFramesPerRead).map(frame => this.wireFrame(frame));
    return {
      frames,
      nextSequence: frames.at(-1)?.sequence ?? after,
      sealed: this.sealed,
    };
  }

  async seal(cutoffAt: string): Promise<SealResult> {
    if (this.startedAt === undefined) throw new MonitorError('invalid_boundary');
    const cutoff = parseCutoffAt(cutoffAt);
    if (this.sealedAt !== undefined && cutoff !== this.sealedAt) throw new MonitorError('invalid_boundary');
    if (this.sealing) return structuredClone(await this.sealing);
    if (cutoff < this.startedAt
      || cutoff - this.monitor.now() > limits.controlCutoffLeadMs) throw new MonitorError('invalid_boundary');
    this.sealedAt = cutoff;
    this.sealing = this.sealAt(cutoff).catch(error => {
      this.monitor.fail(error instanceof MonitorError ? error.code : 'monitor_failed');
      throw error;
    });
    return structuredClone(await this.sealing);
  }

  async close(): Promise<void> {
    if (this.sealing) {
      try { await this.sealing; } catch { /* The failed seal already failed the monitor. */ }
    } else if (this.sealedAt === undefined) this.monitor.fail('monitor_failed');
    this.timer?.close();
    this.timer = undefined;
    await this.monitor.drain();
  }

  private wireFrame(frame: Frame): ControlFrame {
    return {
      source: frame.source,
      sequence: frame.sequence,
      recordedAt: new Date(frame.recordedAt).toISOString(),
      payload: frame.payload,
    };
  }

  private async sealAt(cutoff: number): Promise<SealResult> {
    let remaining = cutoff - this.monitor.now();
    while (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining));
      remaining = cutoff - this.monitor.now();
    }
    this.timer?.close();
    this.timer = undefined;
    const final = await this.monitor.seal(cutoff);
    this.sealed = true;
    return { cutoffAt: new Date(cutoff).toISOString(), final };
  }
}
