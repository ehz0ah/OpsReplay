import { isTerminalSessionId } from './terminal-access.js';
import { isMonitorControlTimestamp } from './monitor-control.js';
import { terminalRecordingSchema } from './terminal-recording.js';

export const playbackLimits = Object.freeze({
  maximumObjectBytes: 256 * 1024,
  // JSON escapes expand a byte by at most six. Each source event also permits
  // a bounded chunk header. This is an export ceiling, not a new source budget.
  maximumTerminalBytes: terminalRecordingSchema.maximumJournalBytes * 6 + terminalRecordingSchema.maximumEvents * 512,
  maximumMetricObjectBytes: 8 * 1024 * 1024,
  // 10,000 schema-bounded Monitor frames, including worst-case JSON escapes.
  maximumMetricBytes: 10_000 * 4096,
  maximumPagesPerPass: 20,
  maximumLinksPerPage: 25,
  maximumResponseBytes: 256 * 1024,
  linkSeconds: 300,
});
export interface PlaybackExportState {
  schemaVersion: 1;
  cutoffAt: string;
  sourceSha256: string;
  terminalCursor: number;
  terminalBytes: number;
  terminalCount: number;
  terminalLastAt: string | null;
  columns: number;
  rows: number;
  utf8Tail: string;
  inputTail: string;
  markerPrefix: string;
  markerDiscard: boolean;
  markerEscaped: boolean;
  terminalDone: boolean;
  metricCursor: number;
  metricScanKey: string | null;
  metricBytes: number;
  metricCount: number;
  metricLastAt: string | null;
  metricsDone: boolean;
  complete: boolean;
  unavailable: 'expired' | null;
}
export interface PlaybackReference {
  schemaVersion: 1;
  kind: 'terminal' | 'metrics';
  source: string | null;
  after: number;
  nextSequence: number;
  objectKey: string;
  sha256: string;
  byteLength: number;
  startedAt: string;
  endedAt: string;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const number = (v: unknown, max: number) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const tail = (v: unknown, max: number) => {
  if (typeof v !== 'string') return false;
  const bytes = Buffer.from(v, 'base64');
  return bytes.length <= max && bytes.toString('base64') === v;
};
export function isPlaybackExportState(v: unknown): v is PlaybackExportState {
  return (
    record(v) &&
    exact(v, [
      'schemaVersion',
      'cutoffAt',
      'sourceSha256',
      'terminalCursor',
      'terminalBytes',
      'terminalCount',
      'terminalLastAt',
      'columns',
      'rows',
      'utf8Tail',
      'inputTail',
      'markerPrefix',
      'markerDiscard',
      'markerEscaped',
      'terminalDone',
      'metricCursor',
      'metricScanKey',
      'metricBytes',
      'metricCount',
      'metricLastAt',
      'metricsDone',
      'complete',
      'unavailable',
    ]) &&
    v.schemaVersion === 1 &&
    isMonitorControlTimestamp(v.cutoffAt) &&
    hash(v.sourceSha256) &&
    number(v.terminalCursor, 100000) &&
    number(v.terminalCount, 100000) &&
    number(v.terminalBytes, playbackLimits.maximumTerminalBytes) &&
    number(v.columns, 500) &&
    (v.columns as number) > 0 &&
    number(v.rows, 500) &&
    (v.rows as number) > 0 &&
    tail(v.utf8Tail, 3) &&
    tail(v.inputTail, 3) &&
    tail(v.markerPrefix, 5) &&
    (v.markerPrefix as string) ===
      Buffer.from('\x1b]133;')
        .subarray(0, Buffer.from(v.markerPrefix as string, 'base64').length)
        .toString('base64') &&
    number(v.metricCursor, 10000) &&
    number(v.metricCount, 10000) &&
    number(v.metricBytes, playbackLimits.maximumMetricBytes) &&
    (v.metricScanKey === null ||
      (typeof v.metricScanKey === 'string' && /^CHUNK#[a-f0-9-]{36}#[0-9]{9}#[0-9]{6}$/.test(v.metricScanKey))) &&
    [v.terminalLastAt, v.metricLastAt].every(
      (x) => x === null || (isMonitorControlTimestamp(x) && x <= (v.cutoffAt as string)),
    ) &&
    [v.terminalDone, v.metricsDone, v.complete, v.markerDiscard, v.markerEscaped].every(
      (x) => typeof x === 'boolean',
    ) &&
    (v.unavailable === null || v.unavailable === 'expired') &&
    v.complete === (v.terminalDone && v.metricsDone) &&
    (v.unavailable === null || v.complete === true) &&
    (!v.terminalDone || (v.utf8Tail === '' && v.inputTail === '' && v.markerPrefix === '')) &&
    (v.markerEscaped === false || v.markerDiscard === true) &&
    (!v.markerDiscard || v.markerPrefix === '') &&
    (v.terminalCount === 0
      ? v.terminalBytes === 0 && v.terminalLastAt === null
      : (v.terminalBytes as number) > 0 && v.terminalLastAt !== null) &&
    (v.metricCount === 0
      ? v.metricBytes === 0 && v.metricLastAt === null
      : (v.metricBytes as number) > 0 && v.metricLastAt !== null)
  );
}
export function playbackObjectKey(id: string, value: Omit<PlaybackReference, 'objectKey'>): string {
  return `sessions/${id}/playback/${value.kind}/${value.source ?? 'empty'}/${String(value.after).padStart(6, '0')}-${String(value.nextSequence).padStart(6, '0')}-${value.sha256}.${value.kind === 'terminal' ? 'cast' : 'json'}`;
}
export function isPlaybackReference(v: unknown, id: string): v is PlaybackReference {
  return (
    isTerminalSessionId(id) &&
    record(v) &&
    exact(v, [
      'schemaVersion',
      'kind',
      'source',
      'after',
      'nextSequence',
      'objectKey',
      'sha256',
      'byteLength',
      'startedAt',
      'endedAt',
    ]) &&
    v.schemaVersion === 1 &&
    ['terminal', 'metrics'].includes(v.kind as string) &&
    (isTerminalSessionId(v.source) ||
      (v.kind === 'metrics' && v.source === null && v.after === 0 && v.nextSequence === 0)) &&
    number(v.after, v.kind === 'terminal' ? 100000 : 10000) &&
    number(v.nextSequence, v.kind === 'terminal' ? 100000 : 10000) &&
    ((v.nextSequence as number) > (v.after as number) || (v.kind === 'metrics' && v.source === null)) &&
    hash(v.sha256) &&
    number(
      v.byteLength,
      v.kind === 'terminal' ? playbackLimits.maximumObjectBytes : playbackLimits.maximumMetricObjectBytes,
    ) &&
    (v.byteLength as number) > 0 &&
    isMonitorControlTimestamp(v.startedAt) &&
    isMonitorControlTimestamp(v.endedAt) &&
    v.startedAt <= v.endedAt &&
    v.objectKey === playbackObjectKey(id, v as unknown as PlaybackReference)
  );
}
