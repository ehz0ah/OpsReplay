import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';
import { journey, validateCheck } from './checks.js';
import { Measurements } from './measurements.js';
import { RecoveryChecks } from './recovery.js';
import { limits, MonitorError, monotonicClock } from './types.js';
import type { Clock, FailureCode, MetricFrame, MonitorConfig, MonitorEvent, PublicFrame, Recovery, Transport } from './types.js';

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
const validFrame = ajv.addSchema(publicSchema).getSchema(publicSchema.$id + '#/$defs/GatewayServerMessage')!;
interface Schedule { lastSlot: number; busy: boolean; revision: number }
const schedule = (): Schedule => ({ lastSlot: -1, busy: false, revision: 0 });
export interface Frame { source: string; sequence: number; recordedAt: number; payload: PublicFrame }

export class Monitor {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly traffic: Schedule[];
  private readonly checks: Schedule[];
  private readonly probes: (Schedule & { failedSince: number | null; outage: boolean })[];
  private readonly samples = schedule();
  private readonly recovery: RecoveryChecks;
  private readonly history: { at: number; view: Recovery }[] = [];
  private readonly frames: Frame[] = [];
  private readonly source = randomUUID();
  private prepared = false;
  private preparing: Promise<boolean> | undefined;
  private measurements: Measurements | undefined;
  private cutoff: number | undefined;
  private sealed: Promise<MetricFrame> | undefined;
  private previousRecovery: Recovery['state'] = 'failing';
  failure: FailureCode | null = null;

  constructor(private readonly config: MonitorConfig, private readonly transport: Transport,
    private readonly clock: Clock = monotonicClock()) {
    this.config = structuredClone(config);
    setMaxListeners(limits.inFlight, this.controller.signal);
    this.traffic = this.config.journeys.map(schedule);
    this.checks = this.config.validators.map(schedule);
    this.probes = this.config.probes.map(() => ({ ...schedule(), failedSince: null, outage: false }));
    this.recovery = new RecoveryChecks(this.config.validators);
  }

  get startedAt(): number | null { return this.measurements?.startedAt ?? null; }
  get stopped(): boolean { return this.controller.signal.aborted; }
  now(): number { return this.clock.now(); }

  async verifyInitialState(): Promise<boolean> {
    if (this.measurements || this.stopped) throw new MonitorError('invalid_boundary');
    if (this.prepared) return true;
    if (this.preparing) return this.preparing;
    const signal = this.controller.signal;
    this.preparing = (async () => {
      const [checks, probes] = await Promise.all([
        Promise.all(this.config.validators.map(v => validateCheck(v.check, this.config.journeys, this.transport, signal))),
        Promise.all(this.config.probes.map(p => this.transport.tcp(p.check.host, p.check.port, p.check.timeoutMs, signal))),
      ]);
      this.prepared = !signal.aborted && checks.some(passed => !passed) && probes.every(Boolean);
      return this.prepared;
    })();
    try { return await this.preparing; }
    finally { this.preparing = undefined; }
  }

  start(): number {
    if (this.measurements) return this.measurements.startedAt;
    if (!this.prepared || this.stopped) throw new MonitorError('initial_state_failed');
    const at = this.now();
    this.measurements = new Measurements(at);
    this.history.push({ at, view: this.recovery.view() });
    return at;
  }

  fail(code: FailureCode): void {
    this.failure ??= code;
    this.controller.abort();
  }

  private launch(run: () => Promise<void>): void {
    if (this.pending.size >= limits.inFlight) { this.fail('traffic_capacity'); return; }
    const work = run().catch(error => this.fail(error instanceof MonitorError ? error.code : 'monitor_failed'))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
  }

  private due(state: Schedule, period: number, at: number): boolean {
    const slot = Math.floor((at - this.measurements!.startedAt) / period);
    if (slot <= state.lastSlot) return false;
    if (slot > state.lastSlot + 1) { this.fail('schedule_gap'); return false; }
    state.lastSlot = slot;
    return true;
  }

  private append(payload: PublicFrame): void {
    if (this.frames.length >= limits.events) throw new MonitorError('record_limit');
    if (!validFrame(payload)) throw new MonitorError('monitor_failed');
    this.frames.push({ source: this.source, sequence: this.frames.length + 1, recordedAt: this.now(), payload });
  }

  private event(signal: MonitorEvent['signal'], at: number, label: string): void {
    this.append({ type: 'timeline', event: { id: `${this.source}:${this.frames.length + 1}`,
      at: new Date(at).toISOString(), kind: 'monitor', signal, label } });
  }

  private checkResult(index: number, ok: boolean, at: number): void {
    this.recovery.result(index, ok, at);
    const view = this.recovery.view();
    if (this.history.length >= limits.records) throw new MonitorError('record_limit');
    this.history.push({ at, view });
    if (view.state !== this.previousRecovery) {
      const signals = { failing: 'recovery_lost', sustaining: 'recovery_sustaining', met: 'recovered' } as const;
      const labels = { failing: 'Recovery checks failed', sustaining: 'Recovery checks are passing', met: 'Checkout recovery confirmed' };
      this.event(signals[view.state], at, labels[view.state]);
      this.previousRecovery = view.state;
    }
  }

  tick(): void {
    if (!this.measurements || this.stopped) return;
    const at = this.now();
    if (at - this.measurements.startedAt > limits.maxDurationMs) { this.fail('record_limit'); return; }
    try {
      this.config.journeys.forEach((j, i) => {
        if (!this.due(this.traffic[i]!, 1000 / j.ratePerSecond, at) || this.stopped) return;
        this.launch(async () => {
          await journey(j, this.transport, this.controller.signal, async (_step, run) => {
            const startedAt = this.now();
            const ok = await run();
            if (!this.stopped) {
              const completedAt = this.now();
              this.measurements!.record({ startedAt, completedAt, durationMs: completedAt - startedAt, failed: !ok });
            }
            return ok;
          });
        });
      });
      this.config.validators.forEach((v, i) => {
        const state = this.checks[i]!;
        if (!this.due(state, limits.evaluationMs, at) || this.stopped) return;
        if (state.busy) {
          state.revision++;
          this.checkResult(i, false, at);
          return;
        }
        const revision = state.revision;
        state.busy = true;
        this.launch(async () => {
          try {
            const ok = await validateCheck(v.check, this.config.journeys, this.transport, this.controller.signal);
            if (!this.stopped) this.checkResult(i, ok && state.revision === revision, this.now());
          } finally { state.busy = false; }
        });
      });
      this.config.probes.forEach((probe, i) => {
        const state = this.probes[i]!;
        if (!this.due(state, limits.evaluationMs, at) || this.stopped || state.busy) return;
        state.busy = true;
        this.launch(async () => {
          try {
            const ok = await this.transport.tcp(probe.check.host, probe.check.port, probe.check.timeoutMs, this.controller.signal);
            if (this.stopped) return;
            const finished = this.now();
            if (ok) {
              if (state.outage) this.event('outage_ended', finished, probe.publicLabel);
              state.failedSince = null;
              state.outage = false;
            } else {
              state.failedSince ??= finished;
              if (!state.outage && finished - state.failedSince >= probe.graceSeconds * 1000) {
                this.event('outage_started', state.failedSince, probe.publicLabel);
                state.outage = true;
              }
            }
          } finally { state.busy = false; }
        });
      });
      if (this.due(this.samples, limits.sampleMs, at) && !this.stopped) {
        this.launch(async () => {
          const frame = await this.snapshot(at);
          if (!this.failure && (this.cutoff === undefined || at <= this.cutoff)) this.append(frame);
        });
      }
    } catch (error) { this.fail(error instanceof MonitorError ? error.code : 'monitor_failed'); }
  }

  read(after = 0): Frame[] {
    if (!Number.isInteger(after) || after < 0 || after > this.frames.length) throw new MonitorError('invalid_boundary');
    return structuredClone(this.frames.slice(after).filter(f => this.cutoff === undefined || f.recordedAt <= this.cutoff));
  }

  async drain(): Promise<void> { await Promise.all([...this.pending]); }

  async snapshot(at = this.now()): Promise<MetricFrame> {
    if (!this.measurements || !Number.isFinite(at) || at < this.measurements.startedAt || at > this.now()
      || (this.cutoff !== undefined && at > this.cutoff)) throw new MonitorError('invalid_boundary');
    if (this.failure) throw new MonitorError(this.failure);
    // Copy the state before yielding, so later completions cannot change this read.
    const recovery = [...this.history].reverse().find(h => h.at <= at)!.view;
    return { type: 'metrics', ...await this.measurements.snapshot(at), recovery: { ...recovery } };
  }

  seal(at = this.cutoff ?? this.now()): Promise<MetricFrame> {
    if (!this.measurements || !Number.isFinite(at) || at < this.measurements.startedAt || at > this.now()
      || (this.cutoff !== undefined && this.cutoff !== at)) throw new MonitorError('invalid_boundary');
    if (this.sealed) return this.sealed.then(frame => structuredClone(frame));
    this.cutoff = at;
    this.controller.abort();
    this.sealed = this.drain().then(() => this.snapshot(at));
    return this.sealed.then(frame => structuredClone(frame));
  }
}
