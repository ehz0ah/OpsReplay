import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { Alert, Badge, Button, Group, Modal, Progress, Tabs } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useTelemetry } from '../telemetry/use-telemetry.js';
import { freshSample } from '../telemetry/state.js';
import { Metric } from '../components/metric.js';
import { Timeline } from '../components/timeline.js';
import { AssistantPanel } from '../assistant/panel.js';
import { Hints } from '../components/hints.js';
import { lazy, Suspense } from 'react';
const TerminalView = lazy(() => import('../terminal/view.js'));
import { useAlive } from '../use-alive.js';
import { ApiError } from '../api.js';
import { useEffect, useMemo, useState, useRef } from 'react';
import { useSession } from '../use-session.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { MutationJournal } from '../mutation-journal.js';
import { endAttempt } from '../end-attempt.js';
import { timeRemaining, terminal } from '../lifecycle.js';
import { Failure } from '../components/failure.js';
import { navigate } from '../navigation.js';
import { AttemptRules, ChallengeBriefing } from '../components/challenge-briefing.js';
export function SessionEntry({ id }: { id: string }) {
  const lastProposal = useRef<string | null>(null);
  const proposalControl = useRef<((id: string, queryOnly?: boolean) => boolean) | null>(null);
  const [proposalStatus, setProposalStatus] = useState<{ id: string; status: PublicTypes['ProposalStatus'] } | null>(
    null,
  );
  const alive = useAlive();
  const wide = useMediaQuery('(min-width: 1100px)');
  const [tab, setTab] = useState<string | null>('terminal');
  const [confirmEnd, setConfirmEnd] = useState(false);
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
    if (ending) return;
    setConfirmEnd(false);
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
      <Modal opened={confirmEnd} onClose={() => setConfirmEnd(false)} title="End this attempt?" centered>
        <p>This attempt cannot be resumed after it ends. The incident clock continues while you decide.</p>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setConfirmEnd(false)} data-autofocus>
            Keep investigating
          </Button>
          <Button color="red" onClick={() => void end()} disabled={ending}>
            End attempt
          </Button>
        </Group>
      </Modal>
      <Button variant="default" onClick={() => navigate('/')}>
        All Challenges
      </Button>
      <Failure error={session.error} retry={session.refresh} />
      {session.error instanceof ApiError && session.error.status === 401 && (
        <Button onClick={() => void auth.signIn()}>Sign in again</Button>
      )}
      <Failure error={endError} retry={() => setConfirmEnd(true)} />
      {!view && !session.error && <p role="status">Reading your attempt…</p>}
      {view && (
        <>
          <header className="workspace-heading">
            <div>
              <p className="eyebrow">
                {view.challenge.category} / {view.challenge.tier}
              </p>
              <h1>{view.challenge.title}</h1>
              <p className="muted">
                Attempt {view.attempt.number} · {view.attempt.kind}
              </p>
            </div>
            <Group gap="md" className="attempt-status">
              <Badge variant="light" color={view.status === 'ready' ? 'teal' : 'gray'}>
                {view.status}
              </Badge>
              {remaining !== null && !terminal(view.status) && (
                <div className="clock">
                  <span>Time remaining</span>
                  <strong aria-label="Time remaining">
                    {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
                  </strong>
                </div>
              )}
            </Group>
          </header>
          {view.status === 'provisioning' ? (
            <Alert title="Starting your environment" role="status">
              This can take tens of seconds. The incident clock starts when the environment is ready. You can leave this
              page and resume the attempt.
            </Alert>
          ) : terminal(view.status) ? (
            <Alert title={`Attempt ${view.status}`} role="status" color="gray">
              <p>{view.statusReason?.replaceAll('_', ' ') ?? 'The attempt has ended.'}</p>
              {view.readyAt === null ? (
                <p>This environment did not reach readiness. Return to Challenges after cleanup to try again.</p>
              ) : view.debriefAvailable ? (
                <Button onClick={() => navigate(`/sessions/${id}/debrief`)}>Open debrief</Button>
              ) : (
                <p>Your debrief is being prepared. Status updates continue automatically.</p>
              )}
            </Alert>
          ) : null}
          <div className="incident-strip">
            <Badge color="red" variant="light">
              {view.alert.severity}
            </Badge>
            <div>
              <strong>{view.alert.title}</strong>
              <p>{view.alert.summary}</p>
            </div>
          </div>
          {view.recovery && (
            <div className="recovery-strip" role="status">
              <strong>Recovery: {view.recovery.state}</strong>
              <Progress
                aria-label="Sustained recovery"
                value={Math.min(
                  100,
                  (view.recovery.sustainedSeconds / Math.max(1, view.recovery.requiredSeconds)) * 100,
                )}
                color="teal"
              />
              <span>
                {view.recovery.sustainedSeconds} / {view.recovery.requiredSeconds}s sustained
              </span>
            </div>
          )}
          {view.status === 'ready' && (
            <>
              <p className="workspace-note">
                Traffic and failures continue while you read or reconnect. Recovery is confirmed by the server.
              </p>
              <Tabs
                value={wide && tab === 'terminal' ? 'telemetry' : tab}
                onChange={setTab}
                keepMounted
                keepMountedMode="display-none"
                className="investigation-workspace"
              >
                <Tabs.List aria-label="Investigation panels">
                  <Tabs.Tab value="terminal" className="terminal-tab">
                    Terminal
                  </Tabs.Tab>
                  <Tabs.Tab value="telemetry">Telemetry</Tabs.Tab>
                  <Tabs.Tab value="briefing">Briefing</Tabs.Tab>
                  <Tabs.Tab value="timeline">Timeline</Tabs.Tab>
                  <Tabs.Tab value="hints">Hints</Tabs.Tab>
                  <Tabs.Tab value="assistant">Assistant</Tabs.Tab>
                </Tabs.List>
                <Tabs.Panel value="terminal" className="workspace-terminal">
                  <Suspense fallback={<p role="status">Opening terminal…</p>}>
                    <TerminalView
                      id={id}
                      enabled={!ending && !endError}
                      refresh={session.refresh}
                      proposalControl={proposalControl}
                      onFrame={(frame) => {
                        telemetry.frame(frame);
                        if (frame.type === 'error' && frame.code === 'TERMINAL_BUSY' && lastProposal.current)
                          setProposalStatus({ id: lastProposal.current, status: 'pending' });
                        if (frame.type === 'proposal_status')
                          setProposalStatus({ id: frame.proposalId, status: frame.status });
                      }}
                      onConnection={telemetry.connection}
                    />
                  </Suspense>
                </Tabs.Panel>
                <Tabs.Panel value="telemetry" className="workspace-evidence">
                  <section className="telemetry-panel" aria-label="Service telemetry">
                    <div className="section-heading">
                      <h2>Service telemetry</h2>
                      <span className="muted">Live Monitor samples</span>
                    </div>
                    {(!freshSample(telemetry.samples.at(-1), now, telemetry.connected) || telemetry.unavailable) && (
                      <Alert role="status" color="yellow">
                        Telemetry is unavailable or stale. These values do not prove current system health.
                      </Alert>
                    )}
                    <div className="metric-grid">
                      {view.dashboard.map((descriptor) => (
                        <Metric key={descriptor.id} descriptor={descriptor} samples={telemetry.samples} />
                      ))}
                    </div>
                    <p className="muted sample-time">
                      {telemetry.samples.at(-1)
                        ? `Last sample: ${new Date(telemetry.samples.at(-1)!.at).toLocaleTimeString()}`
                        : 'Waiting for a saved Monitor sample.'}
                    </p>
                    <Failure error={telemetry.error} />
                  </section>
                </Tabs.Panel>
                <Tabs.Panel value="timeline" className="workspace-evidence">
                  <Timeline items={telemetry.events} />
                </Tabs.Panel>
                <Tabs.Panel value="briefing" className="workspace-evidence">
                  <section aria-label="Challenge briefing">
                    <h2>Challenge briefing</h2>
                    <ChallengeBriefing id={view.challenge.id} version={view.challenge.version} />
                    <details className="command-reference">
                      <summary>Attempt rules</summary>
                      <AttemptRules />
                    </details>
                  </section>
                </Tabs.Panel>
                <Tabs.Panel value="assistant" className="workspace-evidence">
                  <AssistantPanel
                    key={id + (auth.identity?.sub ?? '')}
                    id={id}
                    proposalStatus={proposalStatus}
                    confirmProposal={(proposalId, queryOnly) => {
                      lastProposal.current = proposalId;
                      return !ending && !endError && (proposalControl.current?.(proposalId, queryOnly) ?? false);
                    }}
                  />
                </Tabs.Panel>
                <Tabs.Panel value="hints" className="workspace-evidence">
                  <Hints view={view} now={now} refresh={session.refresh} disabled={ending || Boolean(endError)} />
                </Tabs.Panel>
              </Tabs>
            </>
          )}
          {remaining === 0 && !terminal(view.status) && (
            <p role="status">The displayed time budget has elapsed. Waiting for the server outcome.</p>
          )}
          {!terminal(view.status) && (
            <Button variant="default" disabled={ending} onClick={() => setConfirmEnd(true)}>
              {ending ? 'Confirming outcome…' : 'End attempt'}
            </Button>
          )}
        </>
      )}
    </>
  );
}
