import type { TerminalRecordingEvent } from '../../contracts/private/terminal-recording.js';
import { isTerminalRecordingEvent } from '../../contracts/private/terminal-recording.js';
import { isMonitorControlTimestamp } from '../../contracts/private/monitor-control.js';
import { playbackLimits } from '../../contracts/private/playback-persistence.js';

export interface CastState {
  columns: number;
  rows: number;
  utf8Tail: string;
  inputTail: string;
  markerPrefix: string;
  markerDiscard: boolean;
  markerEscaped: boolean;
}
const marker = Buffer.from('\x1b]133;');
function visible(bytes: Buffer, state: CastState): Buffer {
  let prefix = Buffer.from(state.markerPrefix, 'base64');
  const output: number[] = [];
  for (const byte of bytes) {
    if (state.markerDiscard) {
      if (byte === 7 || (state.markerEscaped && byte === 0x5c)) {
        state.markerDiscard = false;
        state.markerEscaped = false;
      } else state.markerEscaped = byte === 0x1b;
    } else if (byte === marker[prefix.length]) {
      prefix = Buffer.concat([prefix, Buffer.from([byte])]);
      if (prefix.length === marker.length) {
        state.markerDiscard = true;
        prefix = Buffer.alloc(0);
      }
    } else {
      output.push(...prefix);
      prefix = Buffer.alloc(0);
      if (byte === 0x1b) prefix = Buffer.from([byte]);
      else output.push(byte);
    }
  }
  state.markerPrefix = prefix.toString('base64');
  return Buffer.from(output);
}
function decode(bytes: Buffer, tail: string, final: boolean) {
  const joined = Buffer.concat([Buffer.from(tail, 'base64'), bytes]);
  let end = joined.length;
  if (!final) {
    let lead = end - 1;
    while (lead >= 0 && (joined[lead]! & 0xc0) === 0x80 && end - lead <= 4) lead--;
    if (lead >= 0) {
      const first = joined[lead]!;
      const width =
        first >= 0xf0 && first <= 0xf4
          ? 4
          : first >= 0xe0 && first <= 0xef
            ? 3
            : first >= 0xc2 && first <= 0xdf
              ? 2
              : 1;
      if (width > end - lead) end = lead;
    }
  }
  return { text: joined.subarray(0, end).toString('utf8'), tail: joined.subarray(end).toString('base64') };
}
/** Independent v2 chunks share one terminal on the client. Track timestamps place
 * chunks on the session clock. Input is recorded data and must never be executed.
 * Original bytes stay private. Invalid or cut-off UTF-8 renders a replacement. */
export function encodeAsciicast(
  state: CastState,
  events: readonly TerminalRecordingEvent[],
  final = false,
  emptyAt?: string,
) {
  const next: CastState = {
    columns: state.columns,
    rows: state.rows,
    utf8Tail: state.utf8Tail,
    inputTail: state.inputTail,
    markerPrefix: state.markerPrefix,
    markerDiscard: state.markerDiscard,
    markerEscaped: state.markerEscaped,
  };
  const startedAt = events[0]?.recordedAt ?? emptyAt;
  const endedAt = events.at(-1)?.recordedAt ?? emptyAt;
  if (
    !startedAt ||
    !endedAt ||
    (!events.length && !final) ||
    !isMonitorControlTimestamp(startedAt) ||
    events.length > 100 ||
    events.some(
      (v, i) =>
        !isTerminalRecordingEvent(v) ||
        (i > 0 && (v.sequence !== events[i - 1]!.sequence + 1 || v.recordedAt < events[i - 1]!.recordedAt)),
    )
  )
    throw new Error('Invalid terminal export events.');
  const lines: unknown[] = [
    {
      version: 2,
      width: state.columns,
      height: state.rows,
      timestamp: Date.parse(startedAt) / 1000,
      duration: (Date.parse(endedAt) - Date.parse(startedAt)) / 1000,
    },
  ];
  for (const event of events) {
    const time = (Date.parse(event.recordedAt) - Date.parse(startedAt)) / 1000;
    if (event.type === 'dimensions') {
      next.columns = event.columns;
      next.rows = event.rows;
      lines.push([time, 'r', `${event.columns}x${event.rows}`]);
    } else if (event.type === 'output' || event.type === 'input') {
      const output = event.type === 'output';
      const bytes = Buffer.from(event.data, 'base64');
      const value = decode(output ? visible(bytes, next) : bytes, output ? next.utf8Tail : next.inputTail, false);
      if (output) next.utf8Tail = value.tail;
      else next.inputTail = value.tail;
      if (value.text) lines.push([time, output ? 'o' : 'i', value.text]);
    } else lines.push([time, 'm', 'Shell exited']);
  }
  if (final) {
    const time = (Date.parse(endedAt) - Date.parse(startedAt)) / 1000;
    const output = decode(Buffer.from(next.markerPrefix, 'base64'), next.utf8Tail, true);
    const input = decode(Buffer.alloc(0), next.inputTail, true);
    if (output.text) lines.push([time, 'o', output.text]);
    if (input.text) lines.push([time, 'i', input.text]);
    next.utf8Tail = '';
    next.inputTail = '';
    next.markerPrefix = '';
    next.markerDiscard = false;
    next.markerEscaped = false;
  }
  const body = Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  if (body.length > playbackLimits.maximumObjectBytes) throw new Error('Terminal export limit exceeded.');
  return { body, state: next, startedAt, endedAt };
}
