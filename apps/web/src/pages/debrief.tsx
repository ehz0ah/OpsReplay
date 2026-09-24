import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Group, Modal } from '@mantine/core';
import { ArrowDown, RotateCcw, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CheckpointSummary, SessionView } from '@opsreplay/contracts';
import { useWriter } from '../api/mutations.js';
import { useOwner } from '../api/owner.js';
import { read, sessionPath } from '../api/client.js';
import { clock, duration, Failure, Loading, Status } from '../components/common.js';
import { Timeline } from '../components/timeline.js';

export function DebriefView({ session }: { session: SessionView }) {
  const { busy, submit } = useWriter();
  const owner = useOwner();
  const [checkpoint, setCheckpoint] = useState<CheckpointSummary | null>(null);
  const report = useQuery({
    queryKey: ['debrief', session.id],
    queryFn: () => read('Debrief', sessionPath(session.id) + '/debrief', undefined, owner),
  });
  const comparison = useQuery({
    queryKey: ['comparison', session.id],
    queryFn: () => read('Comparison', sessionPath(session.id) + '/comparison', undefined, owner),
    enabled: session.mode === 'replay',
  });
  if (report.isPending) return <Loading label="Loading debrief" />;
  if (report.isError)
    return (
      <Failure
        error={report.error}
        retry={() => {
          void report.refetch();
        }}
      />
    );
  const data = report.data;
  return (
    <div className="debrief-layout">
      <div className="debrief-main">
        <section className="debrief-section">
          <span className="eyebrow">01 / What happened</span>
          <h2>{data.rootCause}</h2>
          <div className="causal-chain">
            {data.causalChain.map((step, index) => (
              <div key={index}>
                {index > 0 && <ArrowDown size={17} aria-hidden="true" />}
                <p>{step}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="debrief-section">
          <span className="eyebrow">02 / Your response</span>
          <h2>Decisions and consequences</h2>
          <ul className="feedback-list">
            {data.actionFeedback.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
          <div className="debrief-evidence">
            <div>
              <h3>Evidence found</h3>
              <ul>
                {data.foundEvidence.map((text) => (
                  <li key={text}>
                    {session.revealedEvidence.find((item) => item.id === text)?.title ??
                      text.replaceAll('-', ' ')}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Evidence missed</h3>
              {data.missedEvidence.length ? (
                <ul>
                  {data.missedEvidence.map((text) => (
                    <li key={text}>
                      {session.revealedEvidence.find((item) => item.id === text)?.title ??
                        text.replaceAll('-', ' ')}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>All key evidence was found.</p>
              )}
            </div>
          </div>
        </section>
        <section className="debrief-section">
          <span className="eyebrow">03 / A recommended path</span>
          <h2>From signal to recovery</h2>
          <ol className="recommended-path">
            {data.recommendedPath.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
        {session.mode === 'replay' && (
          <section className="debrief-section">
            <span className="eyebrow">04 / Compare attempts</span>
            <h2>What changed after the checkpoint?</h2>
            <p className="muted">
              This replay is informed practice. The original attempt stays unchanged.
            </p>
            {comparison.isPending && <Loading label="Loading comparison" />}
            {comparison.isError && (
              <Failure
                error={comparison.error}
                retry={() => {
                  void comparison.refetch();
                }}
              />
            )}
            {comparison.data && (
              <>
                <p className="muted">
                  Shared checkpoint: {clock(comparison.data.checkpointTick, session.tickSeconds)}
                </p>
                <div className="table-scroll">
                  <table className="comparison-table">
                    <thead>
                      <tr>
                        <th>After checkpoint</th>
                        <th>Original</th>
                        <th>Replay</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th>Status</th>
                        <td>
                          <Status status={comparison.data.original.status} />
                        </td>
                        <td>
                          <Status status={comparison.data.replay.status} />
                        </td>
                      </tr>
                      <tr>
                        <th>Time to recovery</th>
                        <td>
                          {comparison.data.original.recoveryTicks === null
                            ? 'Not recovered'
                            : duration(comparison.data.original.recoveryTicks, session.tickSeconds)}
                        </td>
                        <td>
                          {comparison.data.replay.recoveryTicks === null
                            ? 'Not recovered'
                            : duration(comparison.data.replay.recoveryTicks, session.tickSeconds)}
                        </td>
                      </tr>
                      <tr>
                        <th>Impact units</th>
                        <td>{comparison.data.original.impactUnits}</td>
                        <td>{comparison.data.replay.impactUnits}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                {comparison.data.explanations.map((text, index) => (
                  <p key={index}>{text}</p>
                ))}
                <Link to={'/challenges/' + comparison.data.original.sessionId}>
                  View original attempt <ArrowUpRight size={14} />
                </Link>
              </>
            )}
          </section>
        )}
        <section className="debrief-section source-note">
          <h3>Scenario source</h3>
          {data.sources.length ? (
            <ul>
              {data.sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.title}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              This is an original synthetic training scenario. It is not a reconstruction of a named
              company incident.
            </p>
          )}
        </section>
      </div>
      <aside className="debrief-aside">
        <section className="replay-card">
          <RotateCcw size={22} aria-hidden="true" />
          <h2>{session.mode === 'replay' ? 'Your original attempt' : 'Try another decision'}</h2>
          <p>
            {session.mode === 'replay'
              ? 'Open the original debrief to choose another saved decision point.'
              : 'Return to a saved point and take a different path. Your original attempt is preserved.'}
          </p>
          {session.replayOrigin && (
            <Link to={'/challenges/' + session.replayOrigin.parentSessionId}>
              Open original debrief
            </Link>
          )}
          {data.checkpoints.map((item) => (
            <Button
              key={item.id}
              variant="default"
              fullWidth
              disabled={busy}
              justify="space-between"
              rightSection={<ArrowRightIcon />}
              onClick={() => setCheckpoint(item)}
            >
              {item.label} · {clock(item.tick, session.tickSeconds)}
            </Button>
          ))}
        </section>
        <section className="debrief-history">
          <h2>Investigation history</h2>
          <Timeline id={session.id} tickSeconds={session.tickSeconds} />
        </section>
      </aside>
      <Modal
        opened={checkpoint !== null}
        onClose={() => setCheckpoint(null)}
        title="Replay from a checkpoint"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>
          Start a separate, informed attempt from <strong>{checkpoint?.label}</strong> at{' '}
          {clock(checkpoint?.tick ?? 0, session.tickSeconds)}. The evidence and costs before that
          point are preserved.
        </p>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setCheckpoint(null)} data-autofocus>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (!checkpoint) return;
              submit({
                kind: 'replay',
                label: 'Replay ' + checkpoint.label,
                sessionId: session.id,
                body: {
                  requestId: crypto.randomUUID(),
                  expectedVersion: session.version,
                  checkpointId: checkpoint.id,
                },
              });
              setCheckpoint(null);
            }}
          >
            Start replay
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
function ArrowRightIcon() {
  return <ArrowUpRight size={16} aria-hidden="true" />;
}
