/** Private source contract. Interactive terminal v1 frames remain unchanged. */
export const terminalRecordingSchema = Object.freeze({
  version: 1,
  maximumRequestBytes: 1_024,
  maximumResponseBytes: 24 * 1_024,
  maximumJournalBytes: 20_000_000,
  maximumEvents: 100_000,
  maximumPageEvents: 100,
  maximumInputBytes: 16 * 1_024,
  maximumOutputBytes: 8 * 1_024,
  maximumDimension: 500,
  maximumReadsPerSecond: 10,
  postExitSeconds: 60,
} as const);

export interface TerminalRecordingAttach {
  type: 'attach';
  version: 1;
  mode: 'recording';
}

export interface TerminalRecordingRead {
  type: 'read';
  source: string;
  after: number;
}

type EventBase = { sequence: number; recordedAt: string };
export type TerminalRecordingEvent = EventBase &
  (
    | { type: 'input' | 'output'; data: string }
    | { type: 'dimensions'; columns: number; rows: number }
    | { type: 'exit'; code: number }
  );

export interface TerminalRecordingMetadata {
  version: 1;
  source: string;
  startedAt: string;
  initialColumns: 80;
  initialRows: 24;
  latestSequence: number;
  observedAt: string;
  shellState: 'running' | 'exiting' | 'exited';
  loss: { reason: 'limit_exceeded' | 'data_gap'; occurredAt: string } | null;
}

export interface TerminalRecordingReady extends TerminalRecordingMetadata {
  type: 'recording_ready';
}

export interface TerminalRecordingPage extends TerminalRecordingMetadata {
  type: 'recording_page';
  events: TerminalRecordingEvent[];
  nextSequence: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function source(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function canonicalBytes(value: unknown, maximum: number): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= maximum && bytes.toString('base64') === value;
}

export function isTerminalRecordingAttach(value: unknown): value is TerminalRecordingAttach {
  return (
    record(value) &&
    exact(value, ['type', 'version', 'mode']) &&
    value.type === 'attach' &&
    value.version === 1 &&
    value.mode === 'recording'
  );
}

export function isTerminalRecordingRead(value: unknown): value is TerminalRecordingRead {
  return (
    record(value) &&
    exact(value, ['type', 'source', 'after']) &&
    value.type === 'read' &&
    source(value.source) &&
    integer(value.after, 0, terminalRecordingSchema.maximumEvents)
  );
}

export function isTerminalRecordingEvent(value: unknown): value is TerminalRecordingEvent {
  if (
    !record(value) ||
    !integer(value.sequence, 1, terminalRecordingSchema.maximumEvents) ||
    !timestamp(value.recordedAt)
  )
    return false;
  if (value.type === 'input' || value.type === 'output') {
    return (
      exact(value, ['sequence', 'recordedAt', 'type', 'data']) &&
      canonicalBytes(
        value.data,
        value.type === 'input' ? terminalRecordingSchema.maximumInputBytes : terminalRecordingSchema.maximumOutputBytes,
      )
    );
  }
  if (value.type === 'dimensions') {
    return (
      exact(value, ['sequence', 'recordedAt', 'type', 'columns', 'rows']) &&
      integer(value.columns, 1, terminalRecordingSchema.maximumDimension) &&
      integer(value.rows, 1, terminalRecordingSchema.maximumDimension)
    );
  }
  return (
    value.type === 'exit' && exact(value, ['sequence', 'recordedAt', 'type', 'code']) && integer(value.code, -255, 255)
  );
}

const metadataKeys = [
  'type',
  'version',
  'source',
  'startedAt',
  'initialColumns',
  'initialRows',
  'latestSequence',
  'observedAt',
  'shellState',
  'loss',
];

function metadata(value: Record<string, unknown>): value is Record<string, unknown> & TerminalRecordingMetadata {
  if (
    value.version !== 1 ||
    !source(value.source) ||
    !timestamp(value.startedAt) ||
    !timestamp(value.observedAt) ||
    value.observedAt < value.startedAt ||
    value.initialColumns !== 80 ||
    value.initialRows !== 24 ||
    !integer(value.latestSequence, 1, terminalRecordingSchema.maximumEvents) ||
    (value.shellState !== 'running' && value.shellState !== 'exiting' && value.shellState !== 'exited')
  )
    return false;
  const loss = value.loss;
  return (
    loss === null ||
    (record(loss) &&
      exact(loss, ['reason', 'occurredAt']) &&
      (loss.reason === 'limit_exceeded' || loss.reason === 'data_gap') &&
      timestamp(loss.occurredAt) &&
      loss.occurredAt >= value.startedAt &&
      loss.occurredAt <= value.observedAt)
  );
}

export function isTerminalRecordingReady(value: unknown): value is TerminalRecordingReady {
  return record(value) && exact(value, metadataKeys) && value.type === 'recording_ready' && metadata(value);
}

/** Validate after bounded NDJSON parsing. Caller also checks wire bytes and duplicate keys. */
export function isTerminalRecordingPage(
  value: unknown,
  expectedSource: string,
  after: number,
): value is TerminalRecordingPage {
  if (
    !integer(after, 0, terminalRecordingSchema.maximumEvents) ||
    !record(value) ||
    !exact(value, [...metadataKeys, 'events', 'nextSequence']) ||
    value.type !== 'recording_page' ||
    !metadata(value) ||
    value.source !== expectedSource ||
    !Array.isArray(value.events) ||
    value.events.length > terminalRecordingSchema.maximumPageEvents ||
    !integer(value.nextSequence, after, value.latestSequence)
  )
    return false;
  let sequence = after;
  let previousTime = value.startedAt;
  let exited = false;
  for (const event of value.events) {
    if (
      exited ||
      !isTerminalRecordingEvent(event) ||
      event.sequence !== sequence + 1 ||
      event.recordedAt < previousTime ||
      event.recordedAt > value.observedAt ||
      (value.loss !== null && event.recordedAt > value.loss.occurredAt)
    )
      return false;
    if (event.sequence === 1 && (event.type !== 'dimensions' || event.columns !== 80 || event.rows !== 24))
      return false;
    if (event.type === 'exit') {
      if (value.shellState !== 'exited' || event.sequence !== value.latestSequence) return false;
      exited = true;
    }
    sequence = event.sequence;
    previousTime = event.recordedAt;
  }
  if (value.events.length === 0 && after !== value.latestSequence) return false;
  if (
    value.shellState === 'exited' &&
    value.loss === null &&
    sequence === value.latestSequence &&
    value.events.length > 0 &&
    !exited
  )
    return false;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') + 1 > terminalRecordingSchema.maximumResponseBytes) return false;
  return value.nextSequence === sequence;
}
