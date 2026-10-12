import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../../packages/session/src/canonical.js';
import { ResultReadError } from './shared.js';
import { isMonitorControlTimestamp } from '../../../../packages/contracts/private/monitor-control.js';
export function snapshotCursor(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export interface TimelinePosition {
  at: string;
  id: string;
}
export function encodeTimelineCursor(id: string, snapshot: string, position: TimelinePosition) {
  return Buffer.from(JSON.stringify({ v: 2, id, snapshot, after: position })).toString('base64url');
}
export function decodeTimelineCursor(
  value: string | undefined,
  id: string,
  snapshot: string,
): TimelinePosition | undefined {
  if (value === undefined) return undefined;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || value.length > 1000) throw new Error();
    const v = JSON.parse(bytes.toString()) as Record<string, unknown>;
    const after = v.after as TimelinePosition;
    if (
      Object.keys(v).length !== 4 ||
      v.v !== 2 ||
      v.id !== id ||
      v.snapshot !== snapshot ||
      !after ||
      typeof after !== 'object' ||
      Array.isArray(after) ||
      Object.keys(after).length !== 2 ||
      typeof after.id !== 'string' ||
      after.id.length < 1 ||
      after.id.length > 200 ||
      !isMonitorControlTimestamp(after.at)
    )
      throw new Error();
    return after;
  } catch {
    throw new ResultReadError('INVALID_CURSOR');
  }
}
export interface PlaybackPosition {
  phase: number;
  key: string | null;
  count: number;
}
export function encodePlaybackCursor(id: string, snapshot: string, position: PlaybackPosition) {
  return Buffer.from(JSON.stringify({ v: 1, id, snapshot, ...position })).toString('base64url');
}
export function decodePlaybackCursor(value: string | undefined, id: string, snapshot: string): PlaybackPosition {
  if (value === undefined) return { phase: 0, key: null, count: 0 };
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value || value.length > 1000) throw new Error();
    const v = JSON.parse(bytes.toString()) as Record<string, unknown>;
    const prefixes = ['PLAYBACK#metrics#', 'PLAYBACK#terminal#', 'CAPTURE#'];
    if (
      Object.keys(v).length !== 6 ||
      !Number.isSafeInteger(v.count) ||
      (v.count as number) < 0 ||
      (v.count as number) > 100000 ||
      v.v !== 1 ||
      v.id !== id ||
      v.snapshot !== snapshot ||
      !Number.isInteger(v.phase) ||
      (v.phase as number) < 0 ||
      (v.phase as number) > 2 ||
      (v.key !== null &&
        (typeof v.key !== 'string' || !new RegExp(`^${prefixes[v.phase as number]}[0-9]{6}$`).test(v.key)))
    )
      throw new Error();
    return { phase: v.phase as number, key: v.key as string | null, count: v.count as number };
  } catch {
    throw new ResultReadError('INVALID_CURSOR');
  }
}
export function encodeCursor(id: string, snapshot: string, offset: number) {
  return Buffer.from(JSON.stringify({ v: 1, id, snapshot, offset })).toString('base64url');
}
export function decodeCursor(value: string | undefined, id: string, snapshot: string): number {
  if (value === undefined) return 0;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw new Error();
    const v = JSON.parse(bytes.toString()) as Record<string, unknown>;
    if (
      Object.keys(v).length !== 4 ||
      v.v !== 1 ||
      v.id !== id ||
      v.snapshot !== snapshot ||
      !Number.isSafeInteger(v.offset) ||
      (v.offset as number) < 0 ||
      (v.offset as number) > 20000
    )
      throw new Error();
    return v.offset as number;
  } catch {
    throw new ResultReadError('INVALID_CURSOR');
  }
}
