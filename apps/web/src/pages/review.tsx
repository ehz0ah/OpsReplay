import { Button } from '@mantine/core';
import { useMemo, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { useRead } from '../use-read.js';
import { useAlive } from '../use-alive.js';
import { navigate } from '../navigation.js';
import { Failure } from '../components/failure.js';
import { ReviewAttempt } from '../review-attempt.js';
import { ReviewWorkspace } from '../components/review-workspace.js';
import { ReviewDraft } from '../review-draft.js';
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
        A line match means your comment overlaps a reference range. It does not grade your written diagnosis. Compare
        your reasoning below. Unmatched comments carry no penalty.
      </p>
      {result.answerInformed && (
        <p className="notice">You have already submitted this exercise. This attempt is answer-informed.</p>
      )}
      {result.findings.map((finding) => (
        <article className="review-finding" key={finding.id}>
          <p className="eyebrow">
            {finding.found ? 'Line matched' : 'Not flagged'} · {finding.file}:{finding.startLine}
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
  const [busy, setBusy] = useState(false),
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
  async function submit(flags: PublicTypes['Flag'][] = []) {
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
        if (read.data && auth.identity) {
          try {
            new ReviewDraft(sessionStorage, auth.identity.sub, read.data).clear();
          } catch {
            /* The result is already saved on the server. */
          }
        }
        navigate('/review-submissions/' + saved.id);
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
          {(!pending || pending.exerciseVersion === read.data.version) &&
            (!result || result.exerciseVersion === read.data.version) && (
              <ReviewWorkspace
                key={read.data.id + '@' + read.data.version + auth.identity.sub}
                exercise={read.data}
                owner={auth.identity.sub}
                pending={pending}
                busy={busy}
                result={result}
                submit={(values) => void submit(values)}
              />
            )}
          {result && result.exerciseVersion !== read.data.version && (
            <p className="notice">
              This saved submission uses exercise version {result.exerciseVersion}. The current diff has changed. Your
              original result remains below.
            </p>
          )}
        </>
      )}
      {pending && !result && (
        <p className="notice">
          A submission for version {pending.exerciseVersion} is pending. Recover the same request before reviewing
          another version.
        </p>
      )}
      {!result && pending && (!read.data || pending.exerciseVersion !== read.data.version) && (
        <Button loading={busy} onClick={() => void submit()}>
          Recover submission
        </Button>
      )}
      {result && <ReviewResult result={result} />}
    </>
  );
}
