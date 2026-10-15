import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
export function Metric({
  descriptor,
  samples,
}: {
  descriptor: PublicTypes['MetricDescriptor'];
  samples: PublicTypes['MetricSample'][];
}) {
  const latest = samples.at(-1)?.values[descriptor.id];
  const available = samples.filter((sample) => sample.values[descriptor.id] !== undefined);
  const values = available.map((sample) => sample.values[descriptor.id]!);
  const low = Math.min(...values),
    high = Math.max(...values),
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
    segments.at(-1)!.push(`${((at - first) / duration) * 240},${50 - ((value - low) / span) * 40}`);
    previous = at;
  }
  return (
    <section className="metric">
      <h3>{descriptor.label}</h3>
      <strong>
        {latest === undefined ? 'Unavailable' : latest.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </strong>
      <span className="muted">{descriptor.unit.replaceAll('_', ' ')}</span>
      {values.length > 1 && (
        <svg viewBox="0 0 240 60" aria-label={`${descriptor.label} recent samples`} role="img">
          {segments.map((points, index) => (
            <polyline key={index} points={points.join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
          ))}
        </svg>
      )}
    </section>
  );
}
