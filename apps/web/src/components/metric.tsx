/** @jsxRuntime automatic */
import { chartCommands, type RecordedCommand } from '../playback/markers.js';
import type { PlaybackRange } from '../playback/terminal.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
const units: Record<string, string> = {
  requests_per_second: 'req/s',
  percent: '%',
  milliseconds: 'ms',
  mebibytes: 'MiB',
};
export function Metric({
  descriptor,
  samples,
  playback,
}: {
  descriptor: PublicTypes['MetricDescriptor'];
  samples: PublicTypes['MetricSample'][];
  playback?:
    | {
        range: PlaybackRange;
        at: number;
        commands: RecordedCommand[];
        selectedId: string | null;
        onSelect(command: RecordedCommand): void;
      }
    | undefined;
}) {
  const latest = samples.at(-1)?.values[descriptor.id];
  const values = samples.flatMap((sample) =>
    sample.values[descriptor.id] === undefined ? [] : [sample.values[descriptor.id]!],
  );
  const low = Math.min(0, ...values),
    high = Math.max(...values, 1),
    span = high - low || 1;
  const first = playback?.range.start ?? Date.parse(samples[0]?.at ?? ''),
    last = playback?.range.end ?? Date.parse(samples.at(-1)?.at ?? ''),
    duration = last - first || 1;
  const markers = playback ? chartCommands(playback.commands, playback.range, playback.selectedId) : [];
  const x = (at: number) => 30 + ((at - first) / duration) * 265;
  const segments: string[][] = [];
  let previous: number | null = null;
  for (const sample of samples) {
    const value = sample.values[descriptor.id],
      at = Date.parse(sample.at);
    if (value === undefined) {
      previous = null;
      continue;
    }
    if (previous === null || at - previous > 15000) segments.push([]);
    segments.at(-1)!.push(`${x(at)},${62 - ((value - low) / span) * 50}`);
    previous = at;
  }
  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (
    <section className="metric">
      <h3>{descriptor.label}</h3>
      <div className="metric-value">
        <strong>{latest === undefined ? 'Unavailable' : format(latest)}</strong>
        <span className="muted">{units[descriptor.unit] ?? descriptor.unit.replaceAll('_', ' ')}</span>
      </div>
      {(values.length > 1 || playback) && (
        <svg
          viewBox="0 0 300 86"
          preserveAspectRatio="xMidYMid meet"
          aria-label={`${descriptor.label} over time, ${descriptor.unit.replaceAll('_', ' ')}`}
          role={playback ? 'group' : 'img'}
        >
          <line x1="30" y1="62" x2="295" y2="62" stroke="#dce1e1" />
          <line x1="30" y1="12" x2="295" y2="12" stroke="#dce1e1" strokeDasharray="3 3" />
          <text x="0" y="16" fontSize="8" fill="#596873">
            {format(high)}
          </text>
          <text x="0" y="65" fontSize="8" fill="#596873">
            {format(low)}
          </text>
          {segments.map((points, index) => (
            <polyline key={index} points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" />
          ))}
          {playback && (
            <line
              x1={x(playback.at)}
              x2={x(playback.at)}
              y1="12"
              y2="62"
              stroke="#596873"
              strokeDasharray="2 2"
              aria-label="Playback position"
            />
          )}
          {markers.map((command) => (
            <g
              key={command.id}
              className="command-marker"
              role="button"
              tabIndex={0}
              aria-label={`Command ${command.seq}: ${command.command}`}
              aria-pressed={command.id === playback!.selectedId}
              onClick={() => playback!.onSelect(command)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  playback!.onSelect(command);
                }
              }}
            >
              <title>
                {new Date(command.at).toLocaleTimeString()} · {command.command}
              </title>
              <rect x={x(Date.parse(command.at)) - 6} y="8" width="12" height="58" fill="transparent" />
              <line
                x1={x(Date.parse(command.at))}
                x2={x(Date.parse(command.at))}
                y1="12"
                y2="62"
                stroke="currentColor"
                strokeWidth={command.id === playback!.selectedId ? 2 : 1}
                opacity={command.id === playback!.selectedId ? 1 : 0.45}
              />
              <circle cx={x(Date.parse(command.at))} cy="12" r="3" fill="currentColor" />
            </g>
          ))}
          <text x="30" y="80" fontSize="8" fill="#596873">
            {new Date(first).toLocaleTimeString()}
          </text>
          <text x="295" y="80" textAnchor="end" fontSize="8" fill="#596873">
            {new Date(last).toLocaleTimeString()}
          </text>
        </svg>
      )}
      {playback &&
        playback.commands.filter((command) => Date.parse(command.at) >= first && Date.parse(command.at) <= last)
          .length > 120 && (
          <p className="muted">Charts show up to 120 loaded commands. Use the timeline for all loaded commands.</p>
        )}
      {samples.length > 0 && (
        <details>
          <summary>Sample values</summary>
          <table>
            <caption>
              {descriptor.label} · {descriptor.unit.replaceAll('_', ' ')}
            </caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {samples.slice(-60).map((sample) => (
                <tr key={sample.at}>
                  <td>{new Date(sample.at).toLocaleTimeString()}</td>
                  <td>
                    {sample.values[descriptor.id] === undefined ? 'Unavailable' : format(sample.values[descriptor.id]!)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {samples.length > 60 && <p className="muted">Latest 60 samples.</p>}
        </details>
      )}
    </section>
  );
}
