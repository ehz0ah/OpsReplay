/** @jsxRuntime automatic */
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
}: {
  descriptor: PublicTypes['MetricDescriptor'];
  samples: PublicTypes['MetricSample'][];
}) {
  const latest = samples.at(-1)?.values[descriptor.id];
  const values = samples.flatMap((sample) =>
    sample.values[descriptor.id] === undefined ? [] : [sample.values[descriptor.id]!],
  );
  const low = Math.min(0, ...values),
    high = Math.max(...values, 1),
    span = high - low || 1;
  const first = Date.parse(samples[0]?.at ?? ''),
    duration = Date.parse(samples.at(-1)?.at ?? '') - first || 1;
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
    segments.at(-1)!.push(`${30 + ((at - first) / duration) * 265},${62 - ((value - low) / span) * 50}`);
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
      {values.length > 1 && (
        <svg
          viewBox="0 0 300 86"
          preserveAspectRatio="xMidYMid meet"
          aria-label={`${descriptor.label} over time, ${descriptor.unit.replaceAll('_', ' ')}`}
          role="img"
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
          <text x="30" y="80" fontSize="8" fill="#596873">
            {new Date(first).toLocaleTimeString()}
          </text>
          <text x="295" y="80" textAnchor="end" fontSize="8" fill="#596873">
            {new Date(samples.at(-1)!.at).toLocaleTimeString()}
          </text>
        </svg>
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
