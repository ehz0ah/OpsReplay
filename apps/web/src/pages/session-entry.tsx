import { useTelemetry } from '../telemetry/use-telemetry.js';
import { freshSample } from '../telemetry/state.js';
import { Metric } from '../components/metric.js';
import { Timeline } from '../components/timeline.js';
import { Hints } from '../components/hints.js';
import { lazy, Suspense } from 'react';
const TerminalView = lazy(() => import('../terminal/view.js'));
import { useAlive } from '../use-alive.js';
import { ApiError } from '../api.js';
import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../use-session.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { MutationJournal } from '../mutation-journal.js';
import { endAttempt } from '../end-attempt.js';
import { timeRemaining, terminal } from '../lifecycle.js';
import { Failure } from '../components/failure.js';
import { navigate } from '../navigation.js';
export function SessionEntry({ id }: { id: string }) {
  const alive = useAlive();
  const session = useSession(id),
    auth = useAuth(),
    api = useApi();
  const journal = useMemo(() => new MutationJournal(sessionStorage, auth.identity!.sub), [auth.identity?.sub]);
  const [ending, setEnding] = useState(false),
    [endError, setEndError] = useState<Error | null>(null),
    [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function end() {
    if (ending || !confirm('End this attempt? It cannot be resumed. The incident clock continues while you decide.'))
      return;
    setEnding(true);
    setEndError(null);
    try {
      await endAttempt(api, journal, id);
      if (alive.current) session.refresh();
    } catch (value) {
      if (alive.current)
        setEndError(
          value instanceof Error ? value : new Error('The outcome is uncertain. Retry the same end request.'),
        );
    } finally {
      if (alive.current) setEnding(false);
    }
  }
  const telemetry = useTelemetry(id, session.view?.status === 'ready');
  const view = session.view,
    remaining = view ? timeRemaining(view, now) : null;
  return (
    <>
      <button className="secondary" onClick={() => navigate('/')}>
        All Challenges
      </button>
      <Failure error={session.error} retry={session.refresh} />
      {session.error instanceof ApiError && session.error.status === 401 && (
        <button onClick={() => void auth.signIn()}>Sign in again</button>
      )}
      <Failure error={endError} retry={() => void end()} />
      {!view && !session.error && <p role="status">Reading your attempt…</p>}
      {view && (
        <>
          <header className="workspace-heading">
            <div>
              <p className="eyebrow">
                {view.challenge.category} / {view.challenge.tier}
              </p>
              <h1>{view.challenge.title}</h1>
              <span className="badge">
                Attempt {view.attempt.number} · {view.attempt.kind}
              </span>
            </div>
            <div className="stack">
              <span className="badge">{view.status}</span>
              {remaining !== null && !terminal(view.status) && (
                <strong aria-label="Time remaining">
                  {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
                </strong>
              )}
            </div>
          </header>
          {view.status === 'provisioning' ? (
            <div role="status" className="notice">
              <p>Your isolated environment is starting. This can take tens of seconds.</p>
              <p>
                The incident clock starts when the environment is ready. You can leave this page and resume the attempt.
              </p>
            </div>
          ) : terminal(view.status) ? (
            <div role="status" className="notice">
              <h2>Attempt {view.status}</h2>
              <p>{view.statusReason?.replaceAll('_', ' ') ?? 'The attempt has ended.'}</p>
              {view.readyAt === null ? (
                <p>This environment did not reach readiness. Return to Challenges after cleanup to try again.</p>
              ) : view.debriefAvailable ? (
                <button onClick={() => navigate(`/sessions/${id}/debrief`)}>Open debrief</button>
              ) : (
                <p>Your debrief is being prepared. Status updates continue automatically.</p>
              )}
            </div>
          ) : (
            <p className="muted">
              Traffic and failures continue while you investigate or reconnect. Recovery is confirmed by the server.
            </p>
          )}
          <section className="panel">
            <h2>{view.alert.title}</h2>
            <p>{view.alert.summary}</p>
            <span className="badge">{view.alert.severity}</span>
          </section>
          {view.status === 'ready' && (
            <Suspense fallback={<p role="status">Opening terminal…</p>}>
              <TerminalView
                id={id}
                enabled={!ending && !endError}
                refresh={session.refresh}
                onFrame={telemetry.frame}
                onConnection={telemetry.connection}
              />
            </Suspense>
          )}
          {view.status === 'ready' && (
            <>
              <section className="panel">
                <h2>Service telemetry</h2>
                {(!freshSample(telemetry.samples.at(-1), now, telemetry.connected) || telemetry.unavailable) && (
                  <p role="status" className="notice">
                    Telemetry is unavailable or stale. These values do not prove current system health.
                  </p>
                )}
                <div className="metric-grid">
                  {view.dashboard.map((descriptor) => (
                    <Metric key={descriptor.id} descriptor={descriptor} samples={telemetry.samples} />
                  ))}
                </div>
                <p className="muted">
                  {telemetry.samples.at(-1)
                    ? `Last sample: ${new Date(telemetry.samples.at(-1)!.at).toLocaleTimeString()}`
                    : 'Waiting for a saved Monitor sample.'}
                </p>
              </section>
              <Hints view={view} now={now} refresh={session.refresh} disabled={ending || Boolean(endError)} />
              <Failure error={telemetry.error} />
              <Timeline items={telemetry.events} />
            </>
          )}
          {view.recovery && (
            <section className="panel">
              <h2>Recovery: {view.recovery.state}</h2>
              <p>
                {view.recovery.sustainedSeconds} / {view.recovery.requiredSeconds} seconds sustained
              </p>
            </section>
          )}
          {remaining === 0 && !terminal(view.status) && (
            <p role="status">The displayed time budget has elapsed. Waiting for the server outcome.</p>
          )}
          {!terminal(view.status) && (
            <button className="secondary" disabled={ending} onClick={() => void end()}>
              {ending ? 'Confirming outcome…' : 'End attempt'}
            </button>
          )}
        </>
      )}
    </>
  );
}
