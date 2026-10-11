import { captureLimits, isCaptureBaseline, type CaptureBaseline } from './file-capture.js';
import { isMonitorControlTimestamp } from './monitor-control.js';
import { isTerminalSessionId } from './terminal-access.js';

export interface CaptureState {
  schemaVersion: 1;
  baseline: CaptureBaseline;
  cursor: number;
  sequence: number;
  retainedBytes: number;
  incomplete: boolean;
}
export interface CaptureReference {
  schemaVersion: 1;
  objectKey: string;
  sha256: string;
  byteLength: number;
  commandId: string;
  commandSeq: number;
  sequence: number;
  baselineAt: string;
  startedAt: string;
  completedAt: string;
  incomplete: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const count = (v: unknown, maximum: number) =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= maximum;
export function isCaptureState(value: unknown): value is CaptureState {
  return (
    record(value) &&
    exact(value, ['schemaVersion', 'baseline', 'cursor', 'sequence', 'retainedBytes', 'incomplete']) &&
    value.schemaVersion === 1 &&
    isCaptureBaseline(value.baseline) &&
    count(value.cursor, captureLimits.maximumCaptures) &&
    count(value.sequence, captureLimits.maximumCaptures) &&
    (value.sequence as number) <= (value.cursor as number) &&
    count(value.retainedBytes, captureLimits.maximumRetainedBytes) &&
    typeof value.incomplete === 'boolean'
  );
}
export function isCaptureReference(value: unknown, sessionId: string): value is CaptureReference {
  if (
    !isTerminalSessionId(sessionId) ||
    !record(value) ||
    !exact(value, [
      'schemaVersion',
      'objectKey',
      'sha256',
      'byteLength',
      'commandId',
      'commandSeq',
      'sequence',
      'baselineAt',
      'startedAt',
      'completedAt',
      'incomplete',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !isTerminalSessionId(value.commandId) ||
    !count(value.commandSeq, 5000) ||
    value.commandSeq === 0 ||
    !count(value.sequence, 5000) ||
    value.sequence === 0 ||
    !count(value.byteLength, captureLimits.maximumBytes) ||
    value.byteLength === 0 ||
    ![value.baselineAt, value.startedAt, value.completedAt].every(isMonitorControlTimestamp) ||
    (value.baselineAt as string) > (value.startedAt as string) ||
    (value.startedAt as string) > (value.completedAt as string) ||
    typeof value.incomplete !== 'boolean' ||
    typeof value.objectKey !== 'string'
  )
    return false;
  return (
    new RegExp(
      `^sessions/${sessionId}/captures/[0-9]{9}/${String(value.commandSeq).padStart(6, '0')}-${value.sha256}\\.json$`,
    ).test(value.objectKey) && Number(value.objectKey.split('/')[3]) > 0
  );
}
