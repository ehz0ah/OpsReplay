import { createHash } from 'node:crypto';
import { isMonitorControlTimestamp } from './monitor-control.js';
import {
  isTerminalRecordingCheckpoint,
  terminalPersistence,
  type TerminalRecordingCheckpoint,
} from './terminal-persistence.js';
import {
  isTerminalRecordingEvent,
  terminalRecordingSchema,
  type TerminalRecordingEvent,
} from './terminal-recording.js';

export interface SealedTerminalPage {
  schemaVersion: 1;
  objectKey: string;
  sha256: string;
  byteLength: number;
  source: string;
  after: number;
  nextSequence: number;
  eventCount: number;
  firstAt: string;
  lastAt: string;
}
export interface TerminalSealState {
  schemaVersion: 1;
  cutoffAt: string;
  checkpoint: TerminalRecordingCheckpoint;
  cursor: number;
  pageCount: number;
  recordedBytes: number;
  lastAt: string | null;
  excludedAt: string | null;
  complete: boolean;
}
const sourcePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function sealedTerminalPageKey(
  sessionId: string,
  generation: number,
  page: Omit<SealedTerminalPage, 'objectKey'>,
): string {
  return `sessions/${sessionId}/terminal/${String(generation).padStart(9, '0')}/sealed/${page.source}/${String(page.after + 1).padStart(6, '0')}-${String(page.nextSequence).padStart(6, '0')}-${page.sha256}.json`;
}
export function isSealedTerminalPage(value: unknown, sessionId: string): value is SealedTerminalPage {
  if (
    !sourcePattern.test(sessionId) ||
    !record(value) ||
    !exact(value, [
      'schemaVersion',
      'objectKey',
      'sha256',
      'byteLength',
      'source',
      'after',
      'nextSequence',
      'eventCount',
      'firstAt',
      'lastAt',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.objectKey !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !integer(value.byteLength, 1, terminalPersistence.maximumPageBytes) ||
    typeof value.source !== 'string' ||
    !sourcePattern.test(value.source) ||
    !integer(value.after, 0, terminalRecordingSchema.maximumEvents - 1) ||
    !integer(value.nextSequence, value.after + 1, terminalRecordingSchema.maximumEvents) ||
    !integer(value.eventCount, 1, terminalRecordingSchema.maximumPageEvents) ||
    value.nextSequence - value.after !== value.eventCount ||
    !isMonitorControlTimestamp(value.firstAt) ||
    !isMonitorControlTimestamp(value.lastAt) ||
    value.firstAt > value.lastAt
  )
    return false;
  const generation = Number(value.objectKey.split('/')[3]);
  return (
    integer(generation, 1, 999_999_999) &&
    value.objectKey === sealedTerminalPageKey(sessionId, generation, value as unknown as SealedTerminalPage)
  );
}
export function encodeSealedTerminalPage(
  sessionId: string,
  generation: number,
  source: string,
  after: number,
  events: readonly TerminalRecordingEvent[],
) {
  if (
    !sourcePattern.test(sessionId) ||
    !integer(generation, 1, 999_999_999) ||
    !sourcePattern.test(source) ||
    !integer(after, 0, terminalRecordingSchema.maximumEvents - 1) ||
    events.length < 1 ||
    events.length > terminalRecordingSchema.maximumPageEvents ||
    events.some(
      (event, index) =>
        !isTerminalRecordingEvent(event) ||
        event.sequence !== after + index + 1 ||
        (index > 0 && event.recordedAt < events[index - 1]!.recordedAt),
    )
  )
    throw new Error('Invalid sealed terminal page.');
  const body = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: 'terminal_sealed_page',
        sessionId,
        recorderGeneration: generation,
        source,
        after,
        events,
      },
      (_key, value: unknown) =>
        record(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : value,
    ),
  );
  const attributes = {
    schemaVersion: 1 as const,
    sha256: createHash('sha256').update(body).digest('hex'),
    byteLength: body.byteLength,
    source,
    after,
    nextSequence: events.at(-1)!.sequence,
    eventCount: events.length,
    firstAt: events[0]!.recordedAt,
    lastAt: events.at(-1)!.recordedAt,
  };
  const reference = { ...attributes, objectKey: sealedTerminalPageKey(sessionId, generation, attributes) };
  if (!isSealedTerminalPage(reference, sessionId)) throw new Error('Invalid sealed terminal page.');
  return { body, reference };
}
/** Strictly later observation excludes events that share the cutoff millisecond. */
export function terminalCoversCutoff(checkpoint: TerminalRecordingCheckpoint, cutoffAt: string): boolean {
  return (
    checkpoint.metadata.startedAt <= cutoffAt &&
    ((checkpoint.frontier !== null && checkpoint.frontier.recordedAt > cutoffAt) ||
      (checkpoint.cursor === checkpoint.metadata.latestSequence &&
        (checkpoint.metadata.observedAt > cutoffAt || checkpoint.frontier?.type === 'exit')))
  );
}
export function isTerminalSealState(value: unknown): value is TerminalSealState {
  return (
    record(value) &&
    exact(value, [
      'schemaVersion',
      'cutoffAt',
      'checkpoint',
      'cursor',
      'pageCount',
      'recordedBytes',
      'lastAt',
      'excludedAt',
      'complete',
    ]) &&
    value.schemaVersion === 1 &&
    isMonitorControlTimestamp(value.cutoffAt) &&
    isTerminalRecordingCheckpoint(value.checkpoint) &&
    value.checkpoint.metadata.startedAt <= value.cutoffAt &&
    (value.checkpoint.metadata.loss === null || value.checkpoint.metadata.loss.occurredAt > value.cutoffAt) &&
    integer(value.cursor, 0, value.checkpoint.cursor) &&
    integer(value.pageCount, 0, value.cursor) &&
    integer(value.recordedBytes, 0, value.checkpoint.recordedBytes) &&
    typeof value.complete === 'boolean' &&
    (value.lastAt === null ||
      (isMonitorControlTimestamp(value.lastAt) &&
        value.lastAt >= value.checkpoint.metadata.startedAt &&
        value.lastAt <= value.cutoffAt)) &&
    (value.excludedAt === null ||
      (isMonitorControlTimestamp(value.excludedAt) &&
        value.excludedAt > value.cutoffAt &&
        value.cursor < value.checkpoint.cursor &&
        value.checkpoint.frontier !== null &&
        value.excludedAt <= value.checkpoint.frontier.recordedAt)) &&
    (value.cursor === 0
      ? value.pageCount === 0 && value.recordedBytes === 0 && value.lastAt === null
      : value.pageCount > 0 && value.recordedBytes > 0 && value.lastAt !== null) &&
    (!value.complete ||
      (terminalCoversCutoff(value.checkpoint, value.cutoffAt) &&
        (value.excludedAt !== null || value.cursor === value.checkpoint.cursor)))
  );
}
