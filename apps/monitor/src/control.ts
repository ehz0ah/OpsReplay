import type { MetricFrame, PublicFrame } from './types.js';
import { MonitorError, limits } from './types.js';
import type { Frame } from './monitor.js';
import type {
  MonitorControlFrame,
  MonitorControlFramePage,
  MonitorControlHealth,
  MonitorControlSealResponse,
  MonitorControlStartResponse,
} from '../../../packages/contracts/private/monitor-control.js';
import {
  isMonitorControlTimestamp,
  monitorControlSchema,
} from '../../../packages/contracts/private/monitor-control.js';

export type ControlHealth = MonitorControlHealth;
export type ControlFrame = MonitorControlFrame<PublicFrame>;
export type FramePage = MonitorControlFramePage<PublicFrame>;
export type SealResult = MonitorControlSealResponse<MetricFrame>;

interface ControlledMonitor {
  readonly failure: MonitorError['code'] | null;
  now(): number;
  verifyInitialState(): Promise<boolean>;
  start(): number;
  tick(): void;
  read(after?: number, limit?: number): Frame[];
  reserveCutoff(at: number): void;
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
export function parseCutoffAt(value: string): number {
  const parsed = Date.parse(value);
  if (!isMonitorControlTimestamp(value)) throw new MonitorError('invalid_boundary');
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

  constructor(
    private readonly monitor: ControlledMonitor,
    private readonly ticks: ControlScheduler = scheduler,
  ) {}

  health(): ControlHealth {
    return this.monitor.failure ? 'failed' : this.healthState;
  }

  initialise(): Promise<void> {
    if (this.initialising) return this.initialising;
    this.initialising = this.monitor
      .verifyInitialState()
      .then((ready) => {
        this.healthState = ready ? 'ready' : 'failed';
      })
      .catch(() => {
        this.healthState = 'failed';
      });
    return this.initialising;
  }

  start(): MonitorControlStartResponse {
    if (this.health() !== 'ready') throw new MonitorError('invalid_boundary');
    if (this.startedAt === undefined) {
      if (this.sealedAt !== undefined) throw new MonitorError('invalid_boundary');
      this.startedAt = this.monitor.start();
      this.monitor.tick();
      this.timer = this.ticks.every(() => this.monitor.tick(), 25);
    }
    return { startedAt: new Date(this.startedAt).toISOString() };
  }

  read(after: number): FramePage {
    if (this.startedAt === undefined) throw new MonitorError('invalid_boundary');
    const frames = this.monitor
      .read(after, monitorControlSchema.maximumFramesPerPage)
      .map((frame) => this.wireFrame(frame));
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
    if (cutoff < this.startedAt || cutoff - this.monitor.now() > limits.controlCutoffLeadMs)
      throw new MonitorError('invalid_boundary');
    this.monitor.reserveCutoff(cutoff);
    this.sealedAt = cutoff;
    this.sealing = this.sealAt(cutoff).catch((error) => {
      this.monitor.fail(error instanceof MonitorError ? error.code : 'monitor_failed');
      throw error;
    });
    return structuredClone(await this.sealing);
  }

  async close(): Promise<void> {
    if (this.sealing) {
      try {
        await this.sealing;
      } catch {
        /* The failed seal already failed the monitor. */
      }
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
      await new Promise((resolve) => setTimeout(resolve, remaining));
      remaining = cutoff - this.monitor.now();
    }
    this.timer?.close();
    this.timer = undefined;
    const final = await this.monitor.seal(cutoff);
    this.sealed = true;
    return { cutoffAt: new Date(cutoff).toISOString(), final };
  }
}
