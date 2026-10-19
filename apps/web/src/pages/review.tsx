import { Button, Textarea } from '@mantine/core';
import { useMemo, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { useRead } from '../use-read.js';
import { useAlive } from '../use-alive.js';
import { navigate } from '../navigation.js';
import { Failure } from '../components/failure.js';
import { ReviewAttempt } from '../review-attempt.js';
export function ReviewCatalogue() {
  const catalogue = useRead('Catalog', '/v1/catalog?mode=code_review&limit=100');
  return (
    <>
      <p className="eyebrow">Code Review</p>
      <h1>Find the risk before rollout.</h1>
      <p className="intro">Read the change, flag a concern, then compare it with the reference explanation.</p>
      <Failure error={catalogue.error} retry={catalogue.reload} />
      {catalogue.loading && <p role="status">Loading review exercises…</p>}
      {catalogue.data?.items.map((entry) => (
        <article className="challenge-row" key={entry.id + entry.version}>
          <div>
            <span className="content-category">
              {entry.language} · {entry.tier} · {entry.plan}
            </span>
            <h2>{entry.title}</h2>
            <p>{entry.summary}</p>
          </div>
          <Button variant="default" onClick={() => navigate('/reviews/' + entry.id)}>
            Review change
          </Button>
        </article>
      ))}
      {!catalogue.loading && catalogue.data?.items.length === 0 && <p>No review exercises are published.</p>}
    </>
  );
}
export function ReviewResult({ result }: { result: PublicTypes['ReviewSubmission'] }) {
  return (
    <section className="review-result">
      <h2>Your review</h2>
      <p>
        {result.summary.found} reference findings flagged · {result.summary.missed} missed
      </p>
      <p className="muted">
        Written concerns are saved for reflection. They are not graded. Unmatched flags carry no penalty.
      </p>
      {result.answerInformed && (
        <p className="notice">You have already submitted this exercise. This attempt is answer-informed.</p>
      )}
      {result.findings.map((finding) => (
        <article className="review-finding" key={finding.id}>
          <p className="eyebrow">
            {finding.found ? 'Flagged' : 'Missed'} · {finding.file}:{finding.startLine}
            {finding.endLine === finding.startLine ? '' : '-' + finding.endLine}
          </p>
          <h3>{finding.title}</h3>
          <p>{finding.explanation}</p>
          {finding.matchedFlags.map((index) => (
            <blockquote key={index}>{result.flags[index]?.concern}</blockquote>
          ))}
        </article>
      ))}
      {!!result.unmatchedFlags.length && (
        <section>
          <h3>Other concerns</h3>
          {result.unmatchedFlags.map((index) => (
            <p key={index}>
              {result.flags[index]?.file}:{result.flags[index]?.line} · {result.flags[index]?.concern}
            </p>
          ))}
        </section>
      )}
    </section>
  );
}
export function ReviewPage({ id }: { id: string }) {
  const auth = useAuth(),
    api = useApi(),
    alive = useAlive();
  const read = useRead('ReviewExercise', '/v1/reviews/' + id, !!auth.identity && !auth.loading);
  const [flags, setFlags] = useState<PublicTypes['Flag'][]>([]),
    [selected, setSelected] = useState<Omit<PublicTypes['Flag'], 'concern'> | null>(null);
  const [concern, setConcern] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<PublicTypes['ReviewSubmission'] | null>(null);
  const attempt = useMemo(
    () => (auth.identity ? new ReviewAttempt(sessionStorage, auth.identity.sub, id) : null),
    [id, auth.identity?.sub],
  );
  const [pending, setPending] = useState(() => {
    try {
      return attempt?.load() ?? null;
    } catch {
      return null;
    }
  });
  async function submit() {
    if (!attempt || busy || (!read.data && !pending)) return;
    setBusy(true);
    setError(null);
    try {
      const request = pending ?? attempt.begin(read.data!.version, flags);
      setPending(request);
      const saved = await attempt.submit(api, request);
      if (alive.current) {
        setResult(saved);
        setPending(null);
      }
    } catch (value) {
      if (alive.current) {
        setError(value instanceof Error ? value : new Error('Review submission failed.'));
        try {
          setPending(attempt.load());
        } catch {
          /* Keep invalid requests visible through the error. */
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  if (auth.loading) return <p role="status">Connecting your account…</p>;
  if (!auth.identity)
    return (
      <section className="panel">
        <h1>Sign in to review this change.</h1>
        <Button onClick={() => void auth.signIn()}>Sign in</Button>
      </section>
    );
  return (
    <>
      <Button variant="subtle" onClick={() => navigate('/reviews')}>
        All reviews
      </Button>
      {read.loading && <p role="status">Opening exercise…</p>}
      <Failure error={read.error} retry={read.reload} />
      <Failure error={error} />
      {read.data && (
        <>
          <p className="eyebrow">
            {read.data.language} · {read.data.tier}
          </p>
          <h1>{read.data.title}</h1>
          <p className="intro">{read.data.context}</p>
          <p>Choose a line on either side of the diff. Explain the risk you see.</p>
          {read.data.files.map((file) => (
            <section className="review-file" key={file.path}>
              <h2>{file.path}</h2>
              <div className="review-diff" role="region" aria-label={'Diff for ' + file.path} tabIndex={0}>
                {file.lines.map((line, index) => (
                  <div className={'diff-row diff-' + line.kind} key={index}>
                    {(['old', 'new'] as const).map((side) => {
                      const number = side === 'old' ? line.oldLine : line.newLine;
                      return number === null ? (
                        <span className="diff-number" key={side} />
                      ) : (
                        <button
                          className="diff-number"
                          key={side}
                          disabled={!!result || !!pending || busy}
                          aria-label={`Flag ${file.path} ${side} line ${number}`}
                          onClick={() => {
                            setSelected({ file: file.path, side, line: number });
                            setConcern('');
                          }}
                        >
                          {number}
                        </button>
                      );
                    })}
                    <code>
                      {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
                      {line.text}
                    </code>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {selected && !result && !pending && (
            <section className="panel">
              <h2>
                Concern at {selected.file}:{selected.line} ({selected.side})
              </h2>
              <Textarea
                label="Your concern"
                value={concern}
                maxLength={2000}
                onChange={(event) => setConcern(event.currentTarget.value)}
                autosize
                minRows={3}
              />
              <Button
                disabled={!concern.trim() || flags.length >= 50}
                onClick={() => {
                  setFlags((values) => [...values, { ...selected, concern: concern.trim() }]);
                  setSelected(null);
                  setConcern('');
                }}
              >
                Add flag
              </Button>
            </section>
          )}
          {!result && (
            <section>
              <h2>{flags.length} flags</h2>
              {flags.map((flag, index) => (
                <div className="review-flag" key={index}>
                  <p>
                    {flag.file}:{flag.line} ({flag.side}) · {flag.concern}
                  </p>
                  <Button
                    variant="subtle"
                    disabled={!!pending || busy}
                    onClick={() => setFlags((values) => values.filter((_, item) => item !== index))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      {pending && !result && (
        <p className="notice">A saved submission is pending. Retry the same request to recover its result.</p>
      )}
      {!result && (read.data || pending) && (
        <Button disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving review…' : pending ? 'Recover submission' : 'Submit review'}
        </Button>
      )}
      {result && <ReviewResult result={result} />}
    </>
  );
}
