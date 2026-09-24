import { useState } from 'react';
import { Button, Group, Modal, NativeSelect, Tabs } from '@mantine/core';
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  Clock3,
  FileCode2,
  GitBranch,
  ListFilter,
  Network,
  Radio,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import type { Evidence, OperationOffer, SessionView } from '@opsreplay/contracts';
import { useCatalog, useEvents, useSession } from '../api/queries.js';
import { useWriter } from '../api/mutations.js';
import { collectedObservations } from '../api/observations.js';
import { ActionForm } from '../components/action-form.js';
import { EvidenceView } from '../components/evidence-view.js';
import { clock, duration, Failure, humanize, Loading, Status } from '../components/common.js';
import { Timeline } from '../components/timeline.js';
import { DebriefView } from './debrief.js';

const sources = [
  { id: 'alert', label: 'Alert', tools: [], icon: Radio },
  { id: 'metric', label: 'Metrics', tools: ['get_metric'], icon: Activity },
  { id: 'logs', label: 'Logs', tools: ['query_logs'], icon: ListFilter },
  { id: 'deployments', label: 'Deployments', tools: ['list_deployments'], icon: GitBranch },
  { id: 'diff', label: 'Code', tools: ['inspect_diff'], icon: FileCode2 },
  { id: 'architecture', label: 'Topology', tools: ['view_architecture'], icon: Network },
  { id: 'runbook', label: 'Runbook', tools: ['read_runbook'], icon: BookOpen },
  { id: 'status', label: 'Status', tools: ['get_service_status'], icon: Search },
] as const;

export function ChallengePage() {
  const { id = '' } = useParams();
  const query = useSession(id);
  if (query.isPending) return <Loading />;
  if (query.isError)
    return (
      <Failure
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  return <ChallengeWorkspace key={id} session={query.data} />;
}

function ChallengeWorkspace({ session }: { session: SessionView }) {
  const { busy, submit } = useWriter();
  const catalog = useCatalog();
  const title =
    catalog.data?.pages
      .flatMap((page) => page.items)
      .find((entry) => entry.id === session.contentId)?.title ?? humanize(session.contentId);
  const [source, setSource] = useState<string | null>('alert');
  const [view, setView] = useState<string | null>('evidence');
  const [inspection, setInspection] = useState<OperationOffer | null>(null);
  const [endVersion, setEndVersion] = useState<number | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const terminal = session.status !== 'active';
  const selectedSource = sources.find((item) => item.id === source) ?? sources[0];
  const offers = session.availableOperations.filter((offer) =>
    (selectedSource.tools as readonly string[]).includes(offer.tool),
  );
  const mitigations = session.availableOperations.filter((offer) => offer.requiresConfirmation);
  const time = session.availableOperations.find((offer) => offer.tool === 'advance_time');
  const events = useEvents(session.id);
  const knownEvents = events.data?.pages.flatMap((page) => page.items) ?? [];
  const historyComplete = events.isSuccess && !events.hasNextPage && !events.isFetching;
  const observations = collectedObservations(session, knownEvents).filter(
    (item) => item.kind === source,
  );
  const [selectedId, setSelectedId] = useState('');
  const evidence =
    observations.find((item) => item.observationId === selectedId) ?? observations.at(-1);
  function inspect(offer: OperationOffer) {
    const target = sources.find((item) => (item.tools as readonly string[]).includes(offer.tool));
    if (target) {
      setSource(target.id);
      setSelectedId('');
    }
    setInspection(offer);
  }
  return (
    <main id="main" className="challenge-page">
      <div className="workspace-breadcrumb">
        <Link to="/">
          <ArrowLeft size={14} /> Challenges
        </Link>
        <span>/</span>
        <span>{terminal && !showEvidence ? 'Debrief' : 'Investigation'}</span>
        <span className="attempt-label">
          {session.mode === 'replay' ? 'Informed replay' : 'First attempt'}
        </span>
      </div>
      <header className="incident-header">
        <div className="incident-copy">
          <div className="incident-kicker">
            <Status status={session.status} />
            <span>Synthetic scenario</span>
          </div>
          <h1>{title}</h1>
          <p>
            {terminal
              ? 'Review the evidence, your decisions, and their consequences.'
              : 'Find the cause and restore service with the least impact.'}
          </p>
          {session.replayOrigin && (
            <Link
              className="replay-origin"
              to={'/challenges/' + session.replayOrigin.parentSessionId}
            >
              Replayed from {clock(session.replayOrigin.checkpointTick, session.tickSeconds)} · View
              original
            </Link>
          )}
        </div>
        <dl className="incident-stats">
          <div>
            <dt>Simulated time</dt>
            <dd>{clock(session.tick, session.tickSeconds)}</dd>
          </div>
          {session.visibleMetrics.slice(0, 1).map((metric) => (
            <div key={metric.metric}>
              <dt>
                {metric.unit === 'percent' && metric.metric === 'error_percent'
                  ? 'Error rate'
                  : humanize(metric.metric)}
              </dt>
              <dd>
                {metric.value}
                <small>{metric.unit === 'percent' ? '%' : metric.unit}</small>
              </dd>
            </div>
          ))}
          <div>
            <dt>Cumulative impact</dt>
            <dd>
              {session.costs.impactUnits}
              <small>units</small>
            </dd>
          </div>
        </dl>
      </header>
      <div className="workspace-mode">
        <div>
          <span className={terminal && !showEvidence ? '' : 'current'}>Investigation</span>
          <span aria-hidden="true">/</span>
          <span className={terminal && !showEvidence ? 'current' : ''}>Debrief</span>
        </div>
        {terminal ? (
          <Button size="xs" variant="subtle" onClick={() => setShowEvidence(!showEvidence)}>
            {showEvidence ? 'Back to debrief' : 'Review collected evidence'}
          </Button>
        ) : (
          <Button
            size="xs"
            color="gray"
            variant="subtle"
            disabled={busy}
            onClick={() => setEndVersion(session.version)}
          >
            End attempt
          </Button>
        )}
      </div>
      {terminal && !showEvidence ? (
        <DebriefView session={session} />
      ) : (
        <>
          <Tabs value={view} onChange={setView} className="mobile-workspace-tabs">
            <Tabs.List aria-label="Workspace panels">
              <Tabs.Tab value="evidence">Evidence</Tabs.Tab>
              <Tabs.Tab value="history">History</Tabs.Tab>
            </Tabs.List>
          </Tabs>
          <div className={'workspace-grid panel-' + view}>
            <section className="evidence-pane" aria-label="Investigation evidence">
              <Tabs
                value={source}
                onChange={(value) => {
                  setSource(value);
                  setSelectedId('');
                }}
                className="source-tabs"
              >
                <Tabs.List aria-label="Evidence sources">
                  {sources.map((item) => (
                    <Tabs.Tab
                      key={item.id}
                      value={item.id}
                      leftSection={<item.icon size={15} aria-hidden="true" />}
                    >
                      {item.label}
                    </Tabs.Tab>
                  ))}
                </Tabs.List>
                {sources.map((item) => (
                  <Tabs.Panel key={item.id} value={item.id}>
                    {source === item.id && (
                      <>
                        <div className="evidence-toolbar">
                          <div>
                            <span className="eyebrow">{item.label}</span>
                            <h2>{evidence?.title ?? 'Choose what to inspect'}</h2>
                            <p className="muted">
                              {evidence
                                ? 'Observed at ' +
                                  clock(evidence.observedTick, session.tickSeconds) +
                                  (evidence.observedTick < session.tick
                                    ? ' · Earlier observation'
                                    : ' · Latest observation')
                                : 'Only evidence you inspect appears here.'}
                            </p>
                          </div>
                        </div>
                        {!historyComplete && (
                          <div className="observation-picker" role="status">
                            <p className="muted">
                              {events.isPending
                                ? 'Loading observation history.'
                                : 'Some observations and action markers are not loaded yet.'}
                            </p>
                            {events.isError ? (
                              <Button
                                variant="subtle"
                                size="xs"
                                onClick={() => {
                                  void events.refetch();
                                }}
                              >
                                Retry history
                              </Button>
                            ) : (
                              events.hasNextPage && (
                                <Button
                                  variant="subtle"
                                  size="xs"
                                  loading={events.isFetchingNextPage}
                                  onClick={() => {
                                    void events.fetchNextPage();
                                  }}
                                >
                                  Load more observations and history
                                </Button>
                              )
                            )}
                          </div>
                        )}
                        {observations.length > 1 && (
                          <NativeSelect
                            className="observation-picker"
                            label="Collected observations"
                            value={evidence?.observationId}
                            data={observations.map((item) => ({
                              value: item.observationId,
                              label:
                                item.title + ' · ' + clock(item.observedTick, session.tickSeconds),
                            }))}
                            onChange={(event) => setSelectedId(event.currentTarget.value)}
                          />
                        )}
                        <div className="evidence-content">
                          {evidence ? (
                            <EvidenceView
                              evidence={evidence}
                              events={knownEvents}
                              historyComplete={historyComplete}
                              tickSeconds={session.tickSeconds}
                              operations={session.availableOperations}
                              inspect={inspect}
                            />
                          ) : (
                            <EmptyEvidence kind={item.id} />
                          )}
                        </div>
                        {!terminal && offers.length > 0 && (
                          <div className="investigation-options">
                            <h3>Inspect {item.label.toLowerCase()}</h3>
                            {offers.map((offer) => (
                              <Button
                                key={offer.id}
                                variant="default"
                                disabled={busy}
                                rightSection={<ArrowUpRight size={15} />}
                                onClick={() => inspect(offer)}
                              >
                                {offer.label}
                                <span className="button-cost">
                                  {duration(offer.costTicks, session.tickSeconds)}
                                </span>
                              </Button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </Tabs.Panel>
                ))}
              </Tabs>
            </section>
            <aside className="history-pane">
              <div className="history-heading">
                <h2>Investigation history</h2>
                <span className="muted">Actions and system events</span>
              </div>
              <Timeline id={session.id} tickSeconds={session.tickSeconds} />
              <div className="history-note">
                <Clock3 size={15} aria-hidden="true" />
                <p>
                  Time advances when you act.
                  <br />
                  Reading does not use incident time.
                </p>
              </div>
            </aside>
          </div>
          {!terminal && (
            <section className="action-dock" aria-label="Mitigation actions">
              <div className="dock-label">
                <ShieldCheck size={18} aria-hidden="true" />
                <div>
                  <strong>Mitigate</strong>
                  <span>Changes the system</span>
                </div>
              </div>
              <div className="dock-actions">
                {mitigations.map((offer) => (
                  <Button
                    key={offer.id}
                    variant="default"
                    disabled={busy}
                    onClick={() => inspect(offer)}
                  >
                    {offer.label}
                  </Button>
                ))}
              </div>
              {time && (
                <Button
                  className="wait-action"
                  variant="subtle"
                  color="gray"
                  disabled={busy}
                  leftSection={<Clock3 size={15} />}
                  onClick={() => inspect(time)}
                >
                  Advance time
                </Button>
              )}
            </section>
          )}
        </>
      )}
      {inspection && (
        <ActionForm
          key={inspection.id}
          offer={inspection}
          session={session}
          onClose={() => setInspection(null)}
        />
      )}
      <Modal
        opened={endVersion !== null}
        onClose={() => setEndVersion(null)}
        title="End this attempt?"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>
          Your progress will be saved. The debrief will reveal the cause, and this attempt will
          close.
        </p>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setEndVersion(null)} data-autofocus>
            Keep investigating
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              submit({
                kind: 'end',
                label: 'End attempt',
                sessionId: session.id,
                body: {
                  requestId: crypto.randomUUID(),
                  expectedVersion: endVersion ?? session.version,
                },
              });
              setEndVersion(null);
            }}
          >
            End and open debrief
          </Button>
        </Group>
      </Modal>
    </main>
  );
}
function EmptyEvidence({ kind }: { kind: Evidence['kind'] }) {
  return (
    <div className="empty-evidence">
      <Search size={28} strokeWidth={1.4} aria-hidden="true" />
      <h3>{kind === 'diff' ? 'Find a deployment first' : 'No evidence collected yet'}</h3>
      <p>
        {kind === 'diff'
          ? 'Inspect recent deployments to discover the code changes available for review.'
          : 'Use an available inspection below to collect evidence from the system.'}
      </p>
    </div>
  );
}
