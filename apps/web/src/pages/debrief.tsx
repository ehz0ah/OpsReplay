import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { ApiError } from '../api.js';
import { useApi } from '../api-context.js';
import { useAuth } from '../auth/provider.js';
import { useAlive } from '../use-alive.js';
import { useRead } from '../use-read.js';
import { savedDebrief, playbackPages } from '../playback/reads.js';
import { readAsset, metricSamples, captureObject } from '../playback/assets.js';
import { MutationJournal } from '../mutation-journal.js';
import { startAttempt } from '../start-attempt.js';
import { Failure } from '../components/failure.js';
import { Timeline } from '../components/timeline.js';
import { Metric } from '../components/metric.js';
import { navigate } from '../navigation.js';
const RecordedTerminal = lazy(() => import('../playback/terminal-view.js'));
export function DebriefPage({ id }: { id: string }) {
  const api = useApi(),
    auth = useAuth(),
    alive = useAlive(),
    journal = useMemo(() => new MutationJournal(sessionStorage, auth.identity!.sub), [auth.identity?.sub]);
  const [debrief, setDebrief] = useState<PublicTypes['Debrief'] | null>(null),
    [error, setError] = useState<Error | null>(null),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [playback, setPlayback] = useState<PublicTypes['Playback'] | null>(null),
    [samples, setSamples] = useState<PublicTypes['MetricSample'][]>([]),
    [at, setAt] = useState<number | null>(null),
    [capture, setCapture] = useState<PublicTypes['PlaybackCapture'] | null>(null),
    [events, setEvents] = useState<PublicTypes['TimelineEvent'][]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [retryAt, setRetryAt] = useState(0),
    [now, setNow] = useState(Date.now),
    [pending, setPending] = useState(false);
  const operations = useRef(new AbortController()),
    session = useRead('SessionView', `/v1/sessions/${id}`),
    account = useRead('Account', '/v1/me');
  useEffect(() => {
    const controller = new AbortController();
    operations.current = controller;
    setError(null);
    void savedDebrief(api, id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setDebrief(value);
      })
      .catch((value) => {
        if (!controller.signal.aborted) setError(value as Error);
      });
    return () => controller.abort();
  }, [api, id, revision]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    try {
      setPending(Boolean(journal.load('start', '/v1/sessions')));
    } catch (value) {
      setError(value as Error);
    }
    return () => clearInterval(timer);
  }, [journal]);
  async function task(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (value) {
      if (alive.current) {
        setError(value instanceof Error ? value : new Error('Result read failed.'));
        if (value instanceof ApiError) {
          setRetryAt(Date.now() + (value.detail.retryAfterSeconds ?? 0) * 1000);
          if (value.detail.code === 'INVALID_CURSOR') {
            setEvents([]);
            setCursor(null);
          }
        }
        account.reload();
        try {
          setPending(Boolean(journal.load('start', '/v1/sessions')));
        } catch {
          setPending(true);
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function links() {
    const value = await playbackPages(api, id, operations.current.signal);
    if (alive.current) setPlayback(value);
  }
  async function metrics() {
    if (!playback) return;
    const all: PublicTypes['MetricSample'][] = [];
    let bytes = 0;
    for (const track of playback.metrics) {
      const text = await readAsset(track.url, operations.current.signal, 8 * 1024 * 1024);
      bytes += new TextEncoder().encode(text).length;
      if (bytes > 40960000) throw new Error('Metric recording limit exceeded.');
      all.push(...(await metricSamples(text, track)));
      if (all.length > 10001) throw new Error('Metric sample limit exceeded.');
    }
    if (alive.current) {
      setSamples(all);
      setAt(all.at(-1) ? Date.parse(all.at(-1)!.at) : null);
    }
  }
  async function timeline() {
    const page = await api.read(
      'TimelinePage',
      `/v1/sessions/${id}/timeline?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
      operations.current.signal,
    );
    if (alive.current) {
      setEvents((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    }
  }
  async function retry() {
    if (!debrief) return;
    const result = await startAttempt(api, journal, {
      kind: 'start',
      path: '/v1/sessions',
      body: {
        requestId: crypto.randomUUID(),
        challengeId: debrief.challenge.id,
        challengeVersion: debrief.challenge.version,
      },
    });
    if (alive.current) {
      setPending(false);
      navigate(`/sessions/${result.id}`);
    }
  }
  const visible = samples.filter((sample) => at === null || Date.parse(sample.at) <= at).slice(-120);
  return (
    <>
      <button className="secondary" onClick={() => navigate('/')}>
        All Challenges
      </button>
      <Failure
        error={error}
        retry={() => {
          if (!busy) setRevision((value) => value + 1);
        }}
      />
      {!debrief && !error && <p role="status">Preparing your saved debrief…</p>}
      {debrief && (
        <>
          <header className="workspace-heading">
            <div>
              <p className="eyebrow">
                Attempt {debrief.attempt.number} · {debrief.attempt.kind}
              </p>
              <h1>{debrief.challenge.title}</h1>
            </div>
            <span className="badge">{debrief.outcome}</span>
          </header>
          {debrief.recording.status === 'incomplete' && (
            <p className="notice">
              Recording incomplete: {debrief.recording.reason?.replaceAll('_', ' ')}. A final numeric score is
              unavailable.
            </p>
          )}
          <section className="panel">
            <h2>Response results</h2>
            {debrief.score ? (
              <dl className="metric-grid">
                {Object.entries(debrief.score).map(([name, value]) => (
                  <div key={name}>
                    <dt>
                      {
                        (
                          {
                            timeToRecoverySeconds: 'Time to recovery (seconds)',
                            totalRequests: 'Total requests',
                            failedRequests: 'Failed requests',
                            commandCount: 'Commands',
                            observedOutages: 'Observed outages',
                            outageSeconds: 'Outage duration (seconds)',
                          } as Record<string, string>
                        )[name]
                      }
                    </dt>
                    <dd>{value ?? 'Not recovered'}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p>No final score components are available.</p>
            )}
            <p>
              Assistance: {debrief.assistance.hintsReleased} hints, {debrief.assistance.assistantTurns} assistant turns,{' '}
              {debrief.assistance.proposalsRun} proposals.
            </p>
          </section>
          <section className="panel">
            <h2>Root cause</h2>
            <p>{debrief.rootCause}</p>
            <ol>
              {debrief.causalChain.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </section>
          <section className="panel">
            <h2>Evidence</h2>
            <p className="muted">
              Observed means matching saved output. It does not prove understanding. Not observed means no matching
              record.
            </p>
            {debrief.keyEvidence.map((item) => (
              <p key={item.id}>
                <span className="badge">{item.status.replaceAll('_', ' ')}</span> {item.description}
                {item.commandSeq !== null && ` · command ${item.commandSeq}`}
              </p>
            ))}
          </section>
          <section className="panel">
            <h2>Possible harmful actions</h2>
            <p className="muted">These are command and timing associations. They do not establish causality.</p>
            {debrief.possibleHarmfulActions.length === 0 ? (
              <p>No recorded associations.</p>
            ) : (
              debrief.possibleHarmfulActions.map((item) => (
                <p key={item.id}>
                  Command {item.commandSeq}: {item.description}
                </p>
              ))
            )}
            {debrief.outages.map((outage, index) => (
              <p key={index}>
                {outage.label}: {new Date(outage.startedAt).toLocaleTimeString()} to{' '}
                {outage.endedAt ? new Date(outage.endedAt).toLocaleTimeString() : 'outcome cutoff'}
              </p>
            ))}
          </section>
          <section className="panel">
            <h2>Recommended recovery</h2>
            <ol>
              {debrief.recommendedRecovery.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            {debrief.sources.map((source, index) => (
              <p key={index}>
                <a
                  href={
                    /^https?:\/\//.test(source.url) && !new URL(source.url).username && !new URL(source.url).password
                      ? source.url
                      : undefined
                  }
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.title}
                </a>
              </p>
            ))}
          </section>
          <div className="actions">
            <button disabled={busy || now < retryAt} onClick={() => void task(links)}>
              {playback ? 'Refresh recording links' : 'Load recording'}
            </button>
            <button
              className="secondary"
              disabled={busy || events.length >= 16000 || (!cursor && events.length > 0)}
              onClick={() => void task(timeline)}
            >
              {events.length ? 'Load more timeline' : 'Load timeline'}
            </button>
            <button
              disabled={busy || !account.data || (!!account.data.activeSessionId && !pending) || now < retryAt}
              onClick={() => void task(retry)}
            >
              {pending ? 'Recover retry request' : 'Retry as a new attempt'}
            </button>
          </div>
          {account.data?.activeSessionId && (
            <p>
              Another attempt is active or awaiting cleanup.{' '}
              <button className="secondary" onClick={() => navigate(`/sessions/${account.data!.activeSessionId}`)}>
                Open attempt
              </button>
            </p>
          )}
          {now < retryAt && <p role="status">Try again in {Math.ceil((retryAt - now) / 1000)} seconds.</p>}
          <p className="muted">A retry keeps the first attempt and its result unchanged.</p>
          {playback && (
            <>
              <p className="muted">
                Recording links expire at {new Date(playback.expiresAt).toLocaleTimeString()}. Refresh them after
                expiry.
              </p>
              <Suspense fallback={<p>Opening recorded terminal…</p>}>
                <RecordedTerminal
                  key={playback.expiresAt}
                  tracks={playback.terminal}
                  highlights={playback.highlights}
                  onTime={setAt}
                />
              </Suspense>
              <button className="secondary" disabled={busy || now < retryAt} onClick={() => void task(metrics)}>
                Load saved metrics
              </button>
              {at !== null && <p>Playback time: {new Date(at).toLocaleTimeString()}</p>}
              <div className="metric-grid">
                {session.data?.dashboard.map((descriptor) => (
                  <Metric key={descriptor.id} descriptor={descriptor} samples={visible} />
                ))}
              </div>
              <section className="panel">
                <h2>Saved capture intervals</h2>
                <p className="muted">
                  Captures show a baseline and a read interval. They do not identify which command changed each file.
                </p>
                {playback.captures.map((reference, index) => (
                  <button
                    className="secondary"
                    key={index}
                    disabled={busy || now < retryAt}
                    onClick={() =>
                      void task(async () => {
                        const value = await captureObject(
                          await readAsset(reference.url, operations.current.signal, 256 * 1024),
                          reference,
                        );
                        if (alive.current) setCapture(value);
                      })
                    }
                  >
                    Command {reference.commandSeq} · {new Date(reference.startedAt).toLocaleTimeString()}
                  </button>
                ))}
                {capture && (
                  <>
                    <p>
                      Baseline {capture.baselineAt} · Read {capture.startedAt} to {capture.completedAt}
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
              </section>
            </>
          )}
          <Timeline items={events} />
        </>
      )}
    </>
  );
}
