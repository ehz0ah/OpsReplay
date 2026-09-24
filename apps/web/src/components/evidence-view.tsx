import { Alert, Button } from '@mantine/core';
import { ArrowRight, GitCommitHorizontal, Server } from 'lucide-react';
import type { Evidence, LogicalEvent, OperationOffer } from '@opsreplay/contracts';
import { clock } from './common.js';
import { lazy, Suspense } from 'react';
import { Loading } from './common.js';
const MetricChart = lazy(() =>
  import('./metric-chart.js').then((module) => ({ default: module.MetricChart })),
);

export function EvidenceView({
  evidence,
  events,
  historyComplete,
  tickSeconds,
  operations,
  inspect,
}: {
  evidence: Evidence;
  events: LogicalEvent[];
  historyComplete: boolean;
  tickSeconds: number;
  operations: OperationOffer[];
  inspect: (offer: OperationOffer) => void;
}) {
  switch (evidence.kind) {
    case 'alert':
      return (
        <div className="alert-evidence">
          <span className="eyebrow">Incoming alert</span>
          <h3>{evidence.data.service}</h3>
          <p>{evidence.data.message}</p>
          <dl className="alert-detail">
            <div>
              <dt>Affected service</dt>
              <dd>
                <code>{evidence.data.service}</code>
              </dd>
            </div>
            <div>
              <dt>Error rate</dt>
              <dd>{evidence.data.errorPercent}%</dd>
            </div>
          </dl>
          <p className="muted">
            Choose a source to investigate. Each new inspection advances the simulated incident.
          </p>
        </div>
      );
    case 'metric':
      return (
        <Suspense fallback={<Loading label="Loading chart" />}>
          <MetricChart
            evidence={evidence}
            events={events}
            historyComplete={historyComplete}
            tickSeconds={tickSeconds}
          />
        </Suspense>
      );
    case 'logs':
      return evidence.data.entries.length === 0 ? (
        <p className="empty-copy">No log entries match this query.</p>
      ) : (
        <div className="table-scroll">
          <table className="log-table">
            <caption>{evidence.data.service} logs</caption>
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {evidence.data.entries.map((entry, index) => (
                <tr key={index}>
                  <td>{clock(entry.tick, tickSeconds)}</td>
                  <td>
                    <span className={'log-level level-' + entry.severity}>{entry.severity}</span>
                  </td>
                  <td>
                    <code>{entry.message}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'deployments':
      return evidence.data.deployments.length === 0 ? (
        <p className="empty-copy">No deployments in this time window.</p>
      ) : (
        <div className="deployment-list">
          {evidence.data.deployments.map((deployment) => {
            const offer = operations.find(
              (item) => item.tool === 'inspect_diff' && deploymentTarget(item) === deployment.id,
            );
            return (
              <article key={deployment.id}>
                <GitCommitHorizontal size={22} aria-hidden="true" />
                <div>
                  <span className="eyebrow">{clock(deployment.tick, tickSeconds)}</span>
                  <h3>{evidence.data.service}</h3>
                  <p>
                    <code>{deployment.previousVersion}</code>{' '}
                    <ArrowRight size={13} aria-hidden="true" /> <code>{deployment.version}</code>
                  </p>
                  <span className="muted">{deployment.id}</span>
                </div>
                {offer && (
                  <Button variant="default" size="xs" onClick={() => inspect(offer)}>
                    Inspect diff
                  </Button>
                )}
              </article>
            );
          })}
        </div>
      );
    case 'diff':
      return (
        <div className="table-scroll">
          <table className="diff-table">
            <caption>
              {evidence.data.deploymentId} · {evidence.data.language}
            </caption>
            <thead>
              <tr>
                <th>File</th>
                <th>Line</th>
                <th>Change</th>
                <th>Code</th>
              </tr>
            </thead>
            <tbody>
              {evidence.data.lines.map((line) => (
                <tr key={line.id} className={'diff-' + line.kind}>
                  <td>{line.file}</td>
                  <td>{line.line}</td>
                  <td aria-label={line.kind}>
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                  </td>
                  <td>
                    <code>{line.text}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'runbook':
      return (
        <ol className="runbook">
          {evidence.data.steps.map((step, index) => (
            <li key={index}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      );
    case 'architecture':
      return (
        <div>
          <div className="topology-services">
            {evidence.data.services.map((service) => (
              <div key={service}>
                <Server size={20} aria-hidden="true" />
                <code>{service}</code>
              </div>
            ))}
          </div>
          <h3 className="section-title">Service dependencies</h3>
          <ul className="dependency-list">
            {evidence.data.dependencies.map((edge, index) => (
              <li key={index}>
                <code>{edge.from}</code>
                <ArrowRight size={16} aria-label="depends on" />
                <code>{edge.to}</code>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'status':
      return (
        <div className="status-metrics">
          {evidence.data.metrics.map((metric) => (
            <div key={metric.service + metric.metric}>
              <span>{metric.metric}</span>
              <strong>
                {metric.value} <small>{metric.unit}</small>
              </strong>
            </div>
          ))}
          {evidence.data.metrics.length === 0 && (
            <Alert color="gray">No visible status metrics.</Alert>
          )}
        </div>
      );
  }
}

function deploymentTarget(offer: OperationOffer): unknown {
  const properties = offer.argumentSchema.properties;
  if (!properties || typeof properties !== 'object' || !('deploymentId' in properties))
    return undefined;
  const target = properties.deploymentId;
  return target && typeof target === 'object' && 'const' in target ? target.const : undefined;
}
