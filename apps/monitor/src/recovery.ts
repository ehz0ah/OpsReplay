import type { Recovery, Validator } from './types.js';

export class RecoveryChecks {
  private readonly passing: { since: number; last: number }[];
  constructor(private readonly validators: Validator[]) {
    this.passing = validators.map(() => ({ since: NaN, last: NaN }));
  }
  result(index: number, ok: boolean, at: number): void {
    const state = this.passing[index]!;
    if (!ok) {
      state.since = state.last = NaN;
      return;
    }
    if (!Number.isFinite(state.since)) state.since = at;
    state.last = at;
  }
  view(): Recovery {
    const requiredSeconds = Math.max(...this.validators.map((v) => v.sustainSeconds));
    if (this.passing.some((p) => !Number.isFinite(p.since))) {
      return { state: 'failing', sustainedSeconds: 0, requiredSeconds };
    }
    // Advance only on completed checks, never merely because time passed.
    const remaining = Math.max(
      ...this.passing.map((p, i) => Math.max(0, this.validators[i]!.sustainSeconds * 1000 - (p.last - p.since))),
    );
    return {
      state: remaining === 0 ? 'met' : 'sustaining',
      sustainedSeconds: Math.floor(requiredSeconds - remaining / 1000),
      requiredSeconds,
    };
  }
}
