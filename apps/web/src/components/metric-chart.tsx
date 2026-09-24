import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Evidence, LogicalEvent } from '@opsreplay/contracts';
import { clock } from './common.js';

export function MetricChart({
  evidence,
  events,
  historyComplete,
  tickSeconds,
}: {
  evidence: Extract<Evidence, { kind: 'metric' }>;
  events: LogicalEvent[];
  historyComplete: boolean;
  tickSeconds: number;
}) {
  const { samples, unit } = evidence.data;
  const first = samples[0]?.tick ?? 0;
  const last = samples.at(-1)?.tick ?? first;
  const markers = events.filter(
    (event) => event.kind === 'action_started' && event.tick >= first && event.tick <= last,
  );
  return (
    <>
      <div className="chart-summary">
        <span>{evidence.data.service}</span>
        <strong>
          {samples.at(-1)?.value ?? 'No samples'} <small>{unit}</small>
        </strong>
      </div>
      <div
        className="metric-chart"
        role="img"
        aria-label={evidence.title + '. Data and action markers are available in the table below.'}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={samples} margin={{ top: 16, right: 25, left: 0, bottom: 12 }}>
            <CartesianGrid vertical={false} stroke="#e4e8eb" />
            <XAxis
              dataKey="tick"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(tick: number) => clock(tick, tickSeconds)}
              tickLine={false}
              axisLine={false}
              minTickGap={35}
            />
            <YAxis tickLine={false} axisLine={false} width={46} />
            <Tooltip
              labelFormatter={(tick) => clock(Number(tick), tickSeconds)}
              formatter={(value) => [String(value) + ' ' + unit, evidence.title]}
            />
            {markers.map((event) => (
              <ReferenceLine
                key={event.sequence}
                x={event.tick}
                stroke="#8d979e"
                strokeDasharray="3 3"
              />
            ))}
            <Line
              type="linear"
              dataKey="value"
              stroke="#28675a"
              strokeWidth={2.5}
              dot={{ r: samples.length < 12 ? 3 : 0, fill: '#28675a' }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <details className="data-details">
        <summary>View data and action markers</summary>
        <div className="table-scroll">
          <table>
            <caption>
              {evidence.title} ({unit})
            </caption>
            <thead>
              <tr>
                <th>Simulated time</th>
                <th>Value</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {samples.map((sample) => (
                <tr key={sample.tick}>
                  <td>{clock(sample.tick, tickSeconds)}</td>
                  <td>
                    {sample.value} {unit}
                  </td>
                  <td>
                    {markers
                      .filter((event) => event.tick === sample.tick)
                      .map((event) => event.message)
                      .join(' · ') || (historyComplete ? 'None' : 'History incomplete')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
