import { isCommandParserCheckpoint, type CommandParserCheckpoint } from './command-evidence.js';
import { isCaptureState, type CaptureState } from './capture-persistence.js';
import { isTerminalRecordingCheckpoint, type TerminalRecordingCheckpoint } from './terminal-persistence.js';
import { isMonitorControlTimestamp } from './monitor-control.js';

/** Exact task-dependent capture proof. Terminal sealing can reconstruct the same
 * command prefix later without calling the stopped Monitor. */
export interface CaptureCoverage {
  schemaVersion: 1;
  cutoffAt: string;
  terminal: TerminalRecordingCheckpoint;
  parser: CommandParserCheckpoint;
  captures: CaptureState;
}
export function isCaptureCoverage(value: unknown): value is CaptureCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as CaptureCoverage;
  return (
    Object.keys(v).length === 5 &&
    v.schemaVersion === 1 &&
    isMonitorControlTimestamp(v.cutoffAt) &&
    isTerminalRecordingCheckpoint(v.terminal) &&
    isCommandParserCheckpoint(v.parser) &&
    isCaptureState(v.captures) &&
    v.parser.source === v.terminal.metadata.source &&
    v.parser.cursor <= v.terminal.cursor &&
    v.parser.lossAt === null &&
    v.parser.mode === 'text' &&
    v.parser.utf8Tail === '' &&
    !v.captures.unavailable &&
    !v.captures.baseline.unavailable &&
    v.captures.cursor >= v.parser.count &&
    v.captures.cursor === v.captures.sequence
  );
}
