import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { captureObject, metricSamples, readAsset } from './assets.js';
import { terminalRange, type PlaybackRange } from './terminal.js';
type Playback = PublicTypes['Playback'];
export interface EvidencePosition {
  at: number;
  samples: PublicTypes['MetricSample'][];
  capture: PublicTypes['PlaybackCapture'] | null;
  pending: Playback['captures'][number] | null;
}
/** Available metadata bounds, including captures that complete after terminal recording. */
export function playbackRange(playback: Playback): PlaybackRange | null {
  terminalRange(playback.terminal);
  terminalRange(playback.metrics);
  let start = Infinity,
    end = -Infinity;
  for (const track of [...playback.terminal, ...playback.metrics]) {
    start = Math.min(start, Date.parse(track.startedAt));
    end = Math.max(end, Date.parse(track.endedAt));
  }
  for (const capture of playback.captures) {
    const baseline = Date.parse(capture.baselineAt),
      from = Date.parse(capture.startedAt),
      to = Date.parse(capture.completedAt);
    if (!Number.isFinite(baseline) || !Number.isFinite(from) || !Number.isFinite(to) || baseline > from || from > to)
      throw new Error('Invalid capture interval.');
    start = Math.min(start, from);
    end = Math.max(end, to);
  }
  return start === Infinity ? null : { start, end };
}
/** Lazy bounded reads. A caller publishes the returned snapshot only after its current seek succeeds. */
export class EvidenceRecording {
  private metrics = new Map<string, PublicTypes['MetricSample'][]>();
  private captures = new Map<string, PublicTypes['PlaybackCapture']>();
  private bytes = 0;
  private sampleCount = 0;
  constructor(private readonly read = readAsset) {}
  async render(playback: Playback, at: number, signal: AbortSignal): Promise<EvidencePosition> {
    signal.throwIfAborted();
    if (!Number.isFinite(at)) throw new Error('Invalid playback position.');
    const samples: PublicTypes['MetricSample'][] = [];
    for (const track of playback.metrics) {
      if (Date.parse(track.startedAt) > at) break;
      let values = this.metrics.get(track.url);
      if (!values) {
        const text = await this.read(track.url, signal, 8 * 1024 * 1024);
        values = await metricSamples(text, track);
        signal.throwIfAborted();
        const size = new TextEncoder().encode(text).length;
        if (this.bytes + size > 40960000) throw new Error('Metric recording limit exceeded.');
        if (this.sampleCount + values.length > 10001) throw new Error('Metric sample limit exceeded.');
        this.bytes += size;
        this.sampleCount += values.length;
        this.metrics.set(track.url, values);
      }
      samples.push(...values.filter((sample) => Date.parse(sample.at) <= at));
    }
    const ordered = [...new Map(samples.map((sample) => [sample.at, sample])).values()].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    );
    let reference: Playback['captures'][number] | null = null,
      pending: Playback['captures'][number] | null = null;
    for (const capture of playback.captures) {
      if (Date.parse(capture.startedAt) <= at && at < Date.parse(capture.completedAt)) pending = capture;
      if (
        Date.parse(capture.completedAt) <= at &&
        (!reference || Date.parse(capture.completedAt) >= Date.parse(reference.completedAt))
      )
        reference = capture;
    }
    let capture: PublicTypes['PlaybackCapture'] | null = null;
    if (reference) {
      capture = this.captures.get(reference.url) ?? null;
      if (!capture) {
        capture = await captureObject(await this.read(reference.url, signal, 256 * 1024), reference);
        signal.throwIfAborted();
        if (this.captures.size >= 8) this.captures.delete(this.captures.keys().next().value!);
        this.captures.set(reference.url, capture);
      }
    }
    signal.throwIfAborted();
    return { at, samples: ordered.slice(-120), capture, pending };
  }
}
