import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import type { PlaybackRange } from './terminal.js';
export type RecordedCommand = Extract<PublicTypes['TimelineEvent'], { kind: 'command' }>;
export function inPlaybackRange(command: RecordedCommand, range: PlaybackRange | null) {
  const at = Date.parse(command.at);
  return !!range && at >= range.start && at <= range.end;
}
/** Keep chart DOM bounded; the paginated timeline retains every loaded command. */
export function chartCommands(commands: RecordedCommand[], range: PlaybackRange, selectedId: string | null) {
  const eligible = commands.filter((command) => inPlaybackRange(command, range));
  const markers = eligible.slice(-120),
    selected = eligible.find((command) => command.id === selectedId);
  if (selected && !markers.some((command) => command.id === selected.id)) return [selected, ...markers.slice(-119)];
  return markers;
}
