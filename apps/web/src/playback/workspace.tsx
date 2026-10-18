import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { Metric } from '../components/metric.js';
import { Failure } from '../components/failure.js';
import { EvidenceRecording, playbackRange, type EvidencePosition } from './evidence.js';
import type { PlayerState } from './player.js';
const RecordedTerminal = lazy(() => import('./terminal-view.js'));
export function PlaybackWorkspace({
  playback,
  dashboard,
}: {
  playback: PublicTypes['Playback'];
  dashboard: PublicTypes['MetricDescriptor'][];
}) {
  const loader = useMemo(() => new EvidenceRecording(), []),
    prepared = useRef<EvidencePosition | null>(null);
  const [position, setPosition] = useState<EvidencePosition | null>(null),
    [status, setStatus] = useState<PlayerState['status']>('seeking');
  const bounds = useMemo(() => {
    try {
      return { range: playbackRange(playback), error: null };
    } catch (value) {
      return { range: null, error: value instanceof Error ? value : new Error('Invalid recording.') };
    }
  }, [playback]);
  const capture = position?.capture,
    latest = position?.samples.at(-1);
  return (
    <>
      <Failure error={bounds.error} />
      <div className="playback-workspace">
        <Suspense fallback={<p>Opening recorded terminal…</p>}>
          <RecordedTerminal
            tracks={playback.terminal}
            highlights={playback.highlights}
            range={bounds.range}
            prepare={async (at, signal) => {
              prepared.current = await loader.render(playback, at, signal);
            }}
            onState={(state) => {
              setStatus(state.status);
              if (['paused', 'playing', 'ended'].includes(state.status) && prepared.current?.at === state.at)
                setPosition(prepared.current);
            }}
          />
        </Suspense>
        <section className="panel">
          <h2>Saved telemetry</h2>
          {bounds.range && status === 'seeking' ? (
            <p role="status">Preparing saved evidence…</p>
          ) : status === 'error' ? (
            <p>Saved evidence could not be prepared. Retry playback or refresh recording links.</p>
          ) : (
            <>
              {position && <p>Playback time: {new Date(position.at).toLocaleTimeString()}</p>}
              <p className="muted">
                {latest
                  ? `Latest saved sample: ${new Date(latest.at).toLocaleTimeString()} (${Math.max(0, Math.floor((position!.at - Date.parse(latest.at)) / 1000))} seconds before playback).`
                  : 'No saved metric sample at this position.'}{' '}
                Samples show recorded measurements.
              </p>
              <div className="metric-grid">
                {dashboard.map((descriptor) => (
                  <Metric key={descriptor.id} descriptor={descriptor} samples={position?.samples ?? []} />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Saved capture intervals</h2>
        <p className="muted">
          The latest completed capture shows a baseline and a read interval. It does not identify which command changed
          each file.
        </p>
        {bounds.range && status === 'seeking' ? (
          <p role="status">Preparing saved capture…</p>
        ) : status === 'error' ? (
          <p>Capture unavailable at this position.</p>
        ) : (
          <>
            {position?.pending && (
              <p className="notice">
                Capture associated with command {position.pending.commandSeq} is still being read at this playback time.
                Its after-state is available from {new Date(position.pending.completedAt).toLocaleTimeString()}.
              </p>
            )}
            {!capture && <p>No completed capture at this position.</p>}
            {capture && (
              <>
                <p>
                  Capture associated with command {capture.commandSeq}. Baseline {capture.baselineAt} · Read{' '}
                  {capture.startedAt} to {capture.completedAt}
                </p>
                {(capture.incomplete || capture.unavailable) && (
                  <p className="notice">Capture is incomplete or unavailable.</p>
                )}
                {capture.files.map((file) => (
                  <details key={file.path}>
                    <summary>{file.path}</summary>
                    <h3>Before</h3>
                    <pre>{file.before ?? 'Unavailable'}</pre>
                    <h3>After</h3>
                    <pre>{file.after ?? 'Unavailable'}</pre>
                  </details>
                ))}
                {capture.logs.map((log) => (
                  <details key={log.path}>
                    <summary>{log.path}</summary>
                    <pre>{log.lines.join('\n')}</pre>
                  </details>
                ))}
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
