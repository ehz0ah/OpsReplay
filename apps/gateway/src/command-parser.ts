import { TextDecoder } from 'node:util';
import {
  commandEvidenceLimits as limits,
  commandId,
  initialCommandParser,
  isCommandEvidence,
  isCommandParserCheckpoint,
  type CommandEvidence,
  type CommandParserCheckpoint,
} from '../../../packages/contracts/private/command-evidence.js';
import {
  isTerminalRecordingEvent,
  type TerminalRecordingEvent,
} from '../../../packages/contracts/private/terminal-recording.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const bounded = (text: string, maximum: number = limits.maximumTextCharacters) =>
  Array.from(text).slice(0, maximum).join('');

/** Pure, resumable parser. Markers and input remain untrusted reflection evidence. */
export function parseCommandEvents(
  previous: CommandParserCheckpoint,
  events: readonly TerminalRecordingEvent[],
): { checkpoint: CommandParserCheckpoint; commands: CommandEvidence[] } {
  if (!isCommandParserCheckpoint(previous)) throw new Error('Invalid command parser checkpoint.');
  const state = structuredClone(previous);
  const commands: CommandEvidence[] = [];
  const lose = (at: string) => {
    state.lossAt ??= at;
  };
  const publish = (at: string, status: number | null) => {
    const active = state.active;
    if (!active) return;
    const event = { ...active.event, endedAt: status === null ? null : at, exitStatus: status };
    // UTF-8 expansion and JSON escaping also count against the event bound.
    while (Buffer.byteLength(JSON.stringify(event)) > limits.maximumEventBytes && event.outputExcerpt.length) {
      event.outputExcerpt = bounded(event.outputExcerpt, Math.floor(Array.from(event.outputExcerpt).length / 2));
      event.outputTruncated = true;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (!isCommandEvidence(event) || state.retainedBytes + bytes > limits.maximumRetainedBytes) lose(at);
    else {
      commands.push(event);
      state.retainedBytes += bytes;
    }
    state.active = null;
  };
  const start = (command: string, at: string, marked: boolean) => {
    const fallback = state.active && !state.active.marked;
    if (state.active && !fallback) publish(at, null);
    if (!fallback) {
      if (state.count === limits.maximumCommands) {
        lose(at);
        return;
      }
      state.count++;
    }
    const text = bounded(command) || '[command unavailable]';
    if (text !== command) lose(at);
    state.active = {
      event: {
        id: commandId(state.source, state.count),
        at,
        kind: 'command',
        seq: state.count,
        endedAt: null,
        command: text,
        exitStatus: null,
        source: 'learner',
        changedFiles: [],
        outputExcerpt: '',
        outputTruncated: text !== command,
        metrics: null,
      },
      marked,
      fullScreen: false,
    };
    // Leave room for metadata when the command itself contains four-byte characters.
    while (Buffer.byteLength(JSON.stringify(state.active.event)) > limits.maximumEventBytes) {
      state.active.event.command = bounded(
        state.active.event.command,
        Math.floor(Array.from(state.active.event.command).length / 2),
      );
      state.active.event.outputTruncated = true;
      lose(at);
    }
    state.idle = false;
    state.inputLine = '';
  };
  const text = (value: string) => {
    const active = state.active;
    if (!active || active.fullScreen) return;
    if (value === '\b') {
      active.event.outputExcerpt = Array.from(active.event.outputExcerpt).slice(0, -1).join('');
      return;
    }
    if (value === '\r' || (value < ' ' && value !== '\n' && value !== '\t') || value === '\x7f') return;
    // Avoid repeated full-string scans on a large PTY output page. A UTF-16
    // bound is conservative for supplementary Unicode characters.
    if (active.event.outputExcerpt.length + value.length <= limits.maximumTextCharacters)
      active.event.outputExcerpt += value;
    else active.event.outputTruncated = true;
  };
  const osc = (value: string, at: string) => {
    if (value === '133;A') {
      // Missing completion does not prove success, even when a prompt appears.
      publish(at, null);
      state.idle = false;
    } else if (value === '133;B') state.idle = state.active === null;
    else if (value === '133;T') lose(at);
    else if (value.startsWith('133;C;')) {
      const [encoded = '', proposalId] = value.slice(6).split(';');
      if (proposalId && !/^[a-f0-9-]{36}$/.test(proposalId)) {
        lose(at);
        return;
      }
      try {
        const bytes = Buffer.from(encoded, 'base64');
        if (!encoded || bytes.toString('base64') !== encoded || bytes.length > 16_000) throw new Error();
        start(utf8.decode(bytes), at, true);
        if (proposalId && state.active) {
          state.active.event.source = 'assistant';
          state.active.event.proposalId = proposalId;
        }
      } catch {
        lose(at);
      }
    } else if (/^133;D;(?:0|[1-9][0-9]{0,2})$/.test(value)) {
      const status = Number(value.slice(6));
      if (status > 255) lose(at);
      else if (state.active?.marked) publish(at, status);
    } else if (value.startsWith('133;')) lose(at);
  };
  const output = (value: string, at: string) => {
    for (const char of value) {
      if (state.mode === 'text') {
        if (char === '\x1b') {
          state.mode = 'escape';
          state.control = '';
        } else text(char);
      } else if (state.mode === 'escape') {
        state.mode = char === ']' ? 'osc' : char === '[' ? 'csi' : 'text';
      } else if (state.mode === 'csi' || state.mode === 'discard_csi') {
        if (char >= '@' && char <= '~') {
          if (
            state.mode === 'csi' &&
            char === 'h' &&
            /^\?[0-9]+(?:;[0-9]+)*$/.test(state.control) &&
            state.control
              .slice(1)
              .split(';')
              .some((mode) => ['1049', '1047', '47'].includes(mode)) &&
            state.active
          ) {
            state.active.fullScreen = true;
            state.active.event.outputExcerpt = '';
            state.active.event.outputTruncated = true;
          }
          // Conservatively omit all output of commands that enter an alternate screen.
          state.mode = 'text';
          state.control = '';
        } else if (state.mode === 'csi') {
          state.control += char;
          if (state.control.length > 128) {
            state.mode = 'discard_csi';
            state.control = '';
            lose(at);
          }
        }
      } else {
        const terminated = char === '\x07' || (char === '\\' && state.control.endsWith('\x1b'));
        if (terminated) {
          if (state.mode === 'osc')
            osc(state.control.endsWith('\x1b') ? state.control.slice(0, -1) : state.control, at);
          state.mode = 'text';
          state.control = '';
        } else if (state.mode === 'osc') {
          state.control += char;
          if (state.control.length > limits.maximumControlCharacters) {
            state.mode = 'discard_osc';
            state.control = '';
            lose(at);
          }
        } else state.control = char === '\x1b' ? '\x1b' : '';
      }
    }
  };
  for (const event of events) {
    if (!isTerminalRecordingEvent(event) || event.sequence !== state.cursor + 1)
      throw new Error('Command source does not continue.');
    state.cursor = event.sequence;
    if (event.type === 'output') {
      const bytes = Buffer.concat([Buffer.from(state.utf8Tail, 'base64'), Buffer.from(event.data, 'base64')]);
      let end = bytes.length;
      // Save only an incomplete trailing UTF-8 scalar. Invalid complete data marks loss.
      let lead = end - 1;
      while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80 && end - lead <= 4) lead--;
      if (lead >= 0) {
        const first = bytes[lead]!;
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
      state.utf8Tail = bytes.subarray(end).toString('base64');
      try {
        output(utf8.decode(bytes.subarray(0, end)), event.recordedAt);
      } catch {
        lose(event.recordedAt);
        state.utf8Tail = '';
        output(bytes.subarray(0, end).toString('utf8'), event.recordedAt);
      }
    } else if (event.type === 'input') {
      // Only idle shell input can be a command fallback. Input to a running
      // program is never copied into public command text, including no-echo input.
      const value = Buffer.from(event.data, 'base64').toString('utf8');
      if (state.idle && state.active === null) {
        for (const char of value) {
          if (char === '\r' || char === '\n') {
            if (state.inputLine.trim()) start(state.inputLine, event.recordedAt, false);
            state.inputLine = '';
            break;
          } else if (char === '\b' || char === '\x7f')
            state.inputLine = Array.from(state.inputLine).slice(0, -1).join('');
          else if (char === '\x1b') {
            state.inputLine = '';
            state.idle = false;
            break;
          } else if (char >= ' ' || char === '\t') {
            const next = state.inputLine + char;
            state.inputLine = bounded(next);
            if (next !== state.inputLine) lose(event.recordedAt);
          }
        }
      }
    } else if (event.type === 'exit') {
      publish(event.recordedAt, null);
      if (state.utf8Tail || state.mode !== 'text') lose(event.recordedAt);
      state.utf8Tail = '';
      state.control = '';
      state.mode = 'text';
      state.idle = false;
    }
  }
  if (state.active) {
    const event = state.active.event;
    while (Buffer.byteLength(JSON.stringify(event)) > limits.maximumEventBytes && event.outputExcerpt.length) {
      event.outputExcerpt = bounded(event.outputExcerpt, Math.floor(Array.from(event.outputExcerpt).length / 2));
      event.outputTruncated = true;
    }
    while (Buffer.byteLength(JSON.stringify(event)) > limits.maximumEventBytes) {
      event.command = bounded(event.command, Math.floor(Array.from(event.command).length / 2));
      event.outputTruncated = true;
      lose(event.at);
    }
  }
  if (!isCommandParserCheckpoint(state)) throw new Error('Invalid derived command checkpoint.');
  return { checkpoint: state, commands };
}

export { initialCommandParser };
