import type { TerminalRecordingEvent, TerminalRecordingPage, TerminalRecordingReady } from '../terminal-recording.js';

export const terminalFixtureSource = '22222222-2222-4222-8222-222222222222';
export const terminalFixtureStart = '2026-10-12T00:00:00.000Z';
export function terminalReady(overrides: Partial<TerminalRecordingReady> = {}): TerminalRecordingReady {
  return {
    type: 'recording_ready',
    version: 1,
    source: terminalFixtureSource,
    startedAt: terminalFixtureStart,
    initialColumns: 80,
    initialRows: 24,
    latestSequence: 1,
    observedAt: terminalFixtureStart,
    shellState: 'running',
    loss: null,
    ...overrides,
  };
}
export function terminalPage(
  events: TerminalRecordingEvent[] = [
    { type: 'dimensions', sequence: 1, recordedAt: terminalFixtureStart, columns: 80, rows: 24 },
  ],
  overrides: Partial<TerminalRecordingPage> = {},
): TerminalRecordingPage {
  return {
    ...terminalReady(),
    type: 'recording_page',
    events,
    nextSequence: events.at(-1)?.sequence ?? 1,
    latestSequence: events.at(-1)?.sequence ?? 1,
    observedAt: events.at(-1)?.recordedAt ?? terminalFixtureStart,
    ...overrides,
  };
}
export function terminalOutput(
  sequence = 2,
  at = '2026-10-12T00:00:01.000Z',
  bytes: Buffer = Buffer.from('output\r\n'),
): TerminalRecordingEvent {
  return { type: 'output', sequence, recordedAt: at, data: bytes.toString('base64') };
}
