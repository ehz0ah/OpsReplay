import { createHash } from 'node:crypto';
import {
  isTerminalRecordingEvent,
  isTerminalRecordingPage,
  isTerminalRecordingReady,
  terminalRecordingSchema,
  type TerminalRecordingEvent,
  type TerminalRecordingMetadata,
  type TerminalRecordingPage,
  type TerminalRecordingReady,
} from './terminal-recording.js';

/** Private durable source state. The RECORDING item owns the only recorder lease. */
export interface TerminalRecordingCheckpoint {
  schemaVersion: 1;
  metadata: TerminalRecordingMetadata;
  cursor: number;
  frontier: TerminalRecordingEvent | null;
  recordedBytes: number;
}

export interface StoredTerminalPage {
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

export const terminalPersistence = Object.freeze({ maximumPageBytes: 32 * 1_024 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const phase = { running: 0, exiting: 1, exited: 2 };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

export function terminalPageKey(
  sessionId: string,
  generation: number,
  value: Omit<StoredTerminalPage, 'objectKey'>,
): string {
  return (
    `sessions/${sessionId}/terminal/${String(generation).padStart(9, '0')}/live/${value.source}/` +
    `${String(value.after + 1).padStart(6, '0')}-${String(value.nextSequence).padStart(6, '0')}-${value.sha256}.json`
  );
}

export function isStoredTerminalPage(
  value: unknown,
  sessionId: string,
  generation: number,
): value is StoredTerminalPage {
  if (
    !uuid.test(sessionId) ||
    !integer(generation, 1, 999_999_999) ||
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
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !integer(value.byteLength, 1, terminalPersistence.maximumPageBytes) ||
    typeof value.source !== 'string' ||
    !uuid.test(value.source) ||
    !integer(value.after, 0, terminalRecordingSchema.maximumEvents - 1) ||
    !integer(value.nextSequence, value.after + 1, terminalRecordingSchema.maximumEvents) ||
    !integer(value.eventCount, 1, terminalRecordingSchema.maximumPageEvents) ||
    value.nextSequence - value.after !== value.eventCount ||
    typeof value.firstAt !== 'string' ||
    typeof value.lastAt !== 'string'
  )
    return false;
  const timestamp = (at: string) => isTerminalRecordingEvent({ type: 'exit', sequence: 1, recordedAt: at, code: 0 });
  return (
    timestamp(value.firstAt) &&
    timestamp(value.lastAt) &&
    value.firstAt <= value.lastAt &&
    value.objectKey === terminalPageKey(sessionId, generation, value as unknown as StoredTerminalPage)
  );
}

export function encodeTerminalPage(
  sessionId: string,
  generation: number,
  after: number,
  page: TerminalRecordingPage,
): { body: Buffer; reference: StoredTerminalPage } {
  if (
    !uuid.test(sessionId) ||
    !integer(generation, 1, 999_999_999) ||
    !isTerminalRecordingPage(page, page.source, after) ||
    page.events.length === 0
  ) {
    throw new Error('Invalid terminal recording page.');
  }
  const body = Buffer.from(
    JSON.stringify(
      { schemaVersion: 1, kind: 'terminal_page', sessionId, recorderGeneration: generation, after, page },
      (_key, value: unknown) =>
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : value,
    ),
  );
  const attributes = {
    schemaVersion: 1 as const,
    sha256: createHash('sha256').update(body).digest('hex'),
    byteLength: body.byteLength,
    source: page.source,
    after,
    nextSequence: page.nextSequence,
    eventCount: page.events.length,
    firstAt: page.events[0]!.recordedAt,
    lastAt: page.events.at(-1)!.recordedAt,
  };
  const reference = { ...attributes, objectKey: terminalPageKey(sessionId, generation, attributes) };
  if (!isStoredTerminalPage(reference, sessionId, generation)) throw new Error('Invalid terminal recording page.');
  return { body, reference };
}

export function terminalMetadata(value: TerminalRecordingMetadata): TerminalRecordingMetadata {
  return {
    version: value.version,
    source: value.source,
    startedAt: value.startedAt,
    initialColumns: value.initialColumns,
    initialRows: value.initialRows,
    latestSequence: value.latestSequence,
    observedAt: value.observedAt,
    shellState: value.shellState,
    loss: value.loss === null ? null : { ...value.loss },
  };
}

export function isTerminalRecordingCheckpoint(value: unknown): value is TerminalRecordingCheckpoint {
  if (
    !record(value) ||
    !exact(value, ['schemaVersion', 'metadata', 'cursor', 'frontier', 'recordedBytes']) ||
    value.schemaVersion !== 1 ||
    !record(value.metadata) ||
    !isTerminalRecordingReady({ ...value.metadata, type: 'recording_ready' }) ||
    Object.keys(value.metadata).length !== 9 ||
    !integer(value.cursor, 0, value.metadata.latestSequence as number) ||
    !integer(value.recordedBytes, 0, terminalRecordingSchema.maximumJournalBytes)
  )
    return false;
  const metadata = value.metadata as unknown as TerminalRecordingMetadata;
  if (value.cursor === 0) return value.frontier === null && value.recordedBytes === 0;
  if (
    !isTerminalRecordingEvent(value.frontier) ||
    value.frontier.sequence !== value.cursor ||
    value.frontier.recordedAt < metadata.startedAt ||
    value.frontier.recordedAt > metadata.observedAt ||
    value.recordedBytes < Buffer.byteLength(JSON.stringify(value.frontier))
  )
    return false;
  if (
    value.cursor === 1 &&
    (value.frontier.type !== 'dimensions' || value.frontier.columns !== 80 || value.frontier.rows !== 24)
  )
    return false;
  if (value.frontier.type === 'exit')
    return (
      metadata.shellState === 'exited' &&
      value.cursor === metadata.latestSequence &&
      (metadata.loss === null || value.frontier.recordedAt >= metadata.loss.occurredAt)
    );
  return (
    (metadata.shellState !== 'exited' || value.cursor < metadata.latestSequence) &&
    (metadata.loss === null || value.frontier.recordedAt <= metadata.loss.occurredAt)
  );
}

export function initialTerminalCheckpoint(ready: TerminalRecordingReady): TerminalRecordingCheckpoint {
  if (!isTerminalRecordingReady(ready)) throw new Error('Invalid terminal recording metadata.');
  return { schemaVersion: 1, metadata: terminalMetadata(ready), cursor: 0, frontier: null, recordedBytes: 0 };
}

/** Also used on reconnect: source identity is stable across recorder generations. */
export function terminalMetadataContinues(
  previous: TerminalRecordingMetadata,
  next: TerminalRecordingMetadata,
): boolean {
  if (
    previous.source !== next.source ||
    previous.startedAt !== next.startedAt ||
    previous.initialColumns !== next.initialColumns ||
    previous.initialRows !== next.initialRows ||
    next.observedAt < previous.observedAt ||
    next.latestSequence < previous.latestSequence ||
    phase[next.shellState] < phase[previous.shellState] ||
    (previous.shellState !== 'exited' &&
      next.shellState === 'exited' &&
      next.latestSequence === previous.latestSequence)
  )
    return false;
  if (
    previous.shellState === 'exited' &&
    (next.latestSequence !== previous.latestSequence ||
      next.loss?.reason !== previous.loss?.reason ||
      next.loss?.occurredAt !== previous.loss?.occurredAt)
  )
    return false;
  if (previous.loss !== null) {
    if (
      next.loss === null ||
      next.loss.reason !== previous.loss.reason ||
      next.loss.occurredAt !== previous.loss.occurredAt
    )
      return false;
    if (
      next.latestSequence > previous.latestSequence &&
      (next.latestSequence !== previous.latestSequence + 1 || next.shellState !== 'exited')
    )
      return false;
  } else if (next.loss !== null && next.loss.occurredAt < previous.observedAt) return false;
  return true;
}

/** A returned page is not a commit. This pure transition checks the persisted frontier. */
export function advanceTerminalCheckpoint(
  previous: TerminalRecordingCheckpoint,
  page: TerminalRecordingPage,
): TerminalRecordingCheckpoint {
  if (
    !isTerminalRecordingCheckpoint(previous) ||
    !isTerminalRecordingPage(page, previous.metadata.source, previous.cursor) ||
    !terminalMetadataContinues(previous.metadata, page) ||
    (previous.frontier !== null && page.events.some((event) => event.recordedAt < previous.frontier!.recordedAt)) ||
    page.events.some(
      (event) =>
        (event.sequence > previous.metadata.latestSequence && event.recordedAt < previous.metadata.observedAt) ||
        (previous.metadata.loss !== null && event.sequence > previous.metadata.latestSequence && event.type !== 'exit'),
    )
  ) {
    throw new Error('Terminal recording does not continue the saved checkpoint.');
  }
  const next: TerminalRecordingCheckpoint = {
    schemaVersion: 1,
    metadata: terminalMetadata(page),
    cursor: page.nextSequence,
    frontier: structuredClone(page.events.at(-1) ?? previous.frontier),
    recordedBytes:
      previous.recordedBytes + page.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0),
  };
  if (!isTerminalRecordingCheckpoint(next)) throw new Error('Invalid terminal recording checkpoint.');
  return next;
}
