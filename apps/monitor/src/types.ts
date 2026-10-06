export interface HttpCheck {
  method: 'GET' | 'POST';
  url: string;
  expectStatus: number[];
  timeoutMs: number;
}
export interface Journey { id: string; ratePerSecond: number; steps: HttpCheck[] }
export type ValidatorCheck = { kind: 'journey'; journey: string }
  | { kind: 'checkout'; baseUrl: string; timeoutMs: number };
export interface Validator { id: string; check: ValidatorCheck; sustainSeconds: number }
export interface Probe {
  id: string;
  publicLabel: string;
  check: { kind: 'tcp'; host: string; port: number; timeoutMs: number };
  graceSeconds: number;
}
export interface MonitorConfig {
  durationMs: number;
  journeys: Journey[];
  validators: Validator[];
  probes: Probe[];
}
export interface HttpResponse { status: number; body: string }
export interface Transport {
  http(check: HttpCheck, signal: AbortSignal, json?: object): Promise<HttpResponse | null>;
  tcp(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<boolean>;
}
export interface Recovery {
  state: 'failing' | 'sustaining' | 'met';
  sustainedSeconds: number;
  requiredSeconds: number;
}
export interface MetricFrame {
  type: 'metrics';
  sample: { at: string; values: Record<string, number> };
  counters: { totalRequests: number; failedRequests: number };
  recovery: Recovery;
}
export interface MonitorEvent {
  id: string;
  at: string;
  kind: 'monitor';
  signal: 'recovery_sustaining' | 'recovery_lost' | 'recovered' | 'outage_started' | 'outage_ended';
  label: string;
}
export type PublicFrame = MetricFrame | { type: 'timeline'; event: MonitorEvent };
export type FailureCode = 'invalid_config' | 'invalid_boundary' | 'initial_state_failed'
  | 'record_limit' | 'schedule_gap' | 'traffic_capacity' | 'monitor_failed' | 'output_failed';
export class MonitorError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'MonitorError'; }
}
export interface Clock { now(): number }
// Wall-clock adjustments must not change sustain windows or request durations.
export function monotonicClock(): Clock {
  const epoch = Date.now();
  const origin = performance.now();
  return { now: () => Math.floor(epoch + performance.now() - origin) };
}
export const limits = Object.freeze({
  requestRecords: 150_000, recoveryRecords: 100_000, events: 10_000, inFlight: 32,
  bodyBytes: 65_536, manifestBytes: 262_144,
  sampleMs: 5_000, evaluationMs: 1_000, maxScheduleGapMs: 5_000,
});
