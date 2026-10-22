/** @jsxRuntime automatic */
import { useEffect, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { Failure } from './failure.js';

const commands = [
  ['pwd', 'Show your current directory.'],
  ['ls /etc', 'List service configuration directories.'],
  ['tail -n 30 /path/to/log', 'Read the latest lines of a log. Replace the path with one listed below.'],
  ['ss -ltnp', 'List listening TCP ports and process names when available.'],
  ['ps -ef', 'List running processes.'],
  ['curl -i http://127.0.0.1/', 'Send a request to the storefront and show its response headers.'],
] as const;

export function BriefingContent({ briefing }: { briefing: PublicTypes['ChallengeBriefing'] }) {
  return (
    <div className="challenge-briefing">
      <p>{briefing.overview}</p>
      <h3>Service reference</h3>
      <p className="muted">These are file locations, not their contents. Inspect the live environment for evidence.</p>
      {briefing.services.map((service) => (
        <section className="briefing-service" key={service.name}>
          <h4>{service.name}</h4>
          <p>{service.role}</p>
          <dl>
            {[
              { label: 'Configuration', paths: service.configFiles },
              { label: 'Logs', paths: service.logFiles },
            ].map(({ label, paths }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{paths.length ? paths.map((path) => <code key={path}>{path}</code>) : <span>None listed</span>}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <h3>How to investigate</h3>
      <p>Read the alert, inspect service evidence, compare it with the live system, then test your explanation.</p>
      <details className="command-reference">
        <summary>Terminal command reference</summary>
        <dl>
          {commands.map(([command, description]) => (
            <div key={command}>
              <dt>
                <code>{command}</code>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
        </dl>
      </details>
      <p>Validate configuration before you reload a service. Confirm recovery with telemetry and real requests.</p>
    </div>
  );
}

export function ChallengeBriefing({ id, version }: { id: string; version: string }) {
  const [value, setValue] = useState<PublicTypes['ChallengeBriefing'] | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<Error | null>(null),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    setValue(null);
    setLoading(true);
    setError(null);
    void import('../briefing.js')
      .then(({ readBriefing }) => readBriefing(id, version))
      .then((result) => {
        if (!stopped) setValue(result);
      })
      .catch(() => {
        if (!stopped) setError(new Error('The briefing could not load.'));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
  }, [id, version, revision]);
  return (
    <>
      {loading && <p role="status">Loading Challenge briefing…</p>}
      <Failure error={error} retry={() => setRevision((current) => current + 1)} />
      {!loading && !error && !value && (
        <p role="status">
          A briefing is not available for version {version}. Use the terminal to inspect this environment.
        </p>
      )}
      {value && <BriefingContent briefing={value} />}
    </>
  );
}

export function AttemptRules() {
  return (
    <section className="attempt-rules">
      <h3>Before you start</h3>
      <ul>
        <li>
          You have root access inside an isolated Linux environment. Use the terminal to inspect and repair real
          services.
        </li>
        <li>
          The clock starts when the environment is ready. Leaving this page does not pause the incident or its time
          limit. Return within five minutes. Longer disconnection ends the attempt as abandoned.
        </li>
        <li>
          Commands, terminal output and service measurements are recorded for your debrief. Keep credentials out of the
          terminal.
        </li>
        <li>Recovery is confirmed automatically. End attempt stops this attempt permanently.</li>
      </ul>
    </section>
  );
}
