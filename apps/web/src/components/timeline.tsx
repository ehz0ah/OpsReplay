/** @jsxRuntime automatic */
import { inPlaybackRange, type RecordedCommand } from '../playback/markers.js';
import type { PlaybackRange } from '../playback/terminal.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
export function Timeline({
  items,
  playback,
}: {
  items: PublicTypes['TimelineEvent'][];
  playback?: { range: PlaybackRange | null; selectedId: string | null; onSelect(command: RecordedCommand): void };
}) {
  return (
    <section className="panel">
      <h2>Investigation timeline</h2>
      {items.length === 0 && <p className="muted">No saved observations yet.</p>}
      {items.length >= 500 && (
        <p className="notice">
          {playback
            ? `${items.length} loaded observations. Load more timeline pages to see later commands.`
            : 'Showing the latest 500 observations. The recording retains the saved history.'}
        </p>
      )}
      <ol className="timeline">
        {items.map((event) => (
          <li key={event.id}>
            <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
            {event.kind === 'command' ? (
              <>
                {playback && (
                  <button
                    type="button"
                    className="timeline-seek"
                    disabled={!inPlaybackRange(event, playback.range)}
                    aria-pressed={event.id === playback.selectedId}
                    onClick={() => playback.onSelect(event)}
                  >
                    View command {event.seq} at {new Date(event.at).toLocaleTimeString()}
                  </button>
                )}
                {playback && !inPlaybackRange(event, playback.range) && (
                  <span className="muted">Outside loaded playback range.</span>
                )}
                <code>{event.command}</code>
                <span className="muted">
                  {event.source} · {event.endedAt ? `exit ${event.exitStatus ?? 'unknown'}` : 'running'}
                </span>
                {event.outputExcerpt && (
                  <details>
                    <summary>Output</summary>
                    <pre>{event.outputExcerpt}</pre>
                    {event.outputTruncated && <p>Output excerpt truncated.</p>}
                  </details>
                )}
                {event.changedFiles.length > 0 && (
                  <p>
                    Files observed changed in this interval: {event.changedFiles.join(', ')}. This does not establish
                    which command caused the change.
                  </p>
                )}
              </>
            ) : event.kind === 'monitor' ? (
              <p>{event.label}</p>
            ) : event.kind === 'lifecycle' ? (
              <p>
                {event.status} {event.reason?.replaceAll('_', ' ')}
              </p>
            ) : (
              <p>{event.action.replaceAll('_', ' ')}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
