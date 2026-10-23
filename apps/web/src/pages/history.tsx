import { Button } from '@mantine/core';
import { useState } from 'react';
import { useAuth } from '../auth/provider.js';
import { useRead } from '../use-read.js';
import { navigate } from '../navigation.js';
import { Failure } from '../components/failure.js';
import { ReviewResult } from './review.js';
import { ReviewWorkspace } from '../components/review-workspace.js';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
export function HistoryPage() {
  const auth = useAuth();
  const [sessionCursor, setSessionCursor] = useState<string | null>(null),
    [reviewCursor, setReviewCursor] = useState<string | null>(null);
  const enabled = !!auth.identity && !auth.loading;
  const sessions = useRead(
    'SessionPage',
    '/v1/sessions?limit=20' + (sessionCursor ? '&cursor=' + encodeURIComponent(sessionCursor) : ''),
    enabled,
  );
  const reviews = useRead(
    'ReviewSubmissionPage',
    '/v1/review-submissions?limit=20' + (reviewCursor ? '&cursor=' + encodeURIComponent(reviewCursor) : ''),
    enabled,
  );
  if (auth.loading) return <p role="status">Connecting your account…</p>;
  if (!auth.identity)
    return (
      <section className="panel">
        <h1>Sign in to open your history.</h1>
        <Button onClick={() => void auth.signIn()}>Sign in</Button>
      </section>
    );
  return (
    <>
      <p className="eyebrow">Your practice</p>
      <h1>Return to your evidence.</h1>
      <p className="intro">
        Reopen an attempt or compare it with a later retry. Saved results retain their original outcome.
      </p>
      <section>
        <h2>Challenge attempts</h2>
        <Failure
          error={sessions.error}
          retry={() => {
            setSessionCursor(null);
            sessions.reload();
          }}
        />
        {sessions.loading && <p role="status">Loading attempts…</p>}
        {sessions.data?.items.map((item) => (
          <article className="challenge-row" key={item.id}>
            <div>
              <span className="content-category">
                {item.status} · {item.attempt.kind === 'first' ? 'First attempt' : 'Retry ' + item.attempt.number}
              </span>
              <h3>{item.challenge.title}</h3>
              <p>
                {new Date(item.createdAt).toLocaleString()} · {item.challenge.version}
              </p>
            </div>
            <Button variant="default" onClick={() => navigate('/sessions/' + item.id)}>
              Open attempt
            </Button>
          </article>
        ))}
        {!sessions.loading && sessions.data?.items.length === 0 && <p>No Challenge attempts yet.</p>}
        <div className="actions">
          {sessionCursor && (
            <Button variant="subtle" onClick={() => setSessionCursor(null)}>
              Newest attempts
            </Button>
          )}
          {sessions.data?.nextCursor && (
            <Button variant="default" onClick={() => setSessionCursor(sessions.data!.nextCursor)}>
              Older attempts
            </Button>
          )}
        </div>
      </section>
      <section>
        <h2>Code Review submissions</h2>
        <Failure
          error={reviews.error}
          retry={() => {
            setReviewCursor(null);
            reviews.reload();
          }}
        />
        {reviews.loading && <p role="status">Loading reviews…</p>}
        {reviews.data?.items.map((item) => (
          <article className="challenge-row" key={item.id}>
            <div>
              <span className="content-category">{item.answerInformed ? 'Answer-informed' : 'First submission'}</span>
              <h3>{item.exerciseId}</h3>
              <p>
                {new Date(item.submittedAt).toLocaleString()} · {item.found} flagged · {item.missed} missed
              </p>
            </div>
            <Button variant="default" onClick={() => navigate('/review-submissions/' + item.id)}>
              Open result
            </Button>
          </article>
        ))}
        {!reviews.loading && reviews.data?.items.length === 0 && <p>No Code Review submissions yet.</p>}
        <div className="actions">
          {reviewCursor && (
            <Button variant="subtle" onClick={() => setReviewCursor(null)}>
              Newest reviews
            </Button>
          )}
          {reviews.data?.nextCursor && (
            <Button variant="default" onClick={() => setReviewCursor(reviews.data!.nextCursor)}>
              Older reviews
            </Button>
          )}
        </div>
      </section>
    </>
  );
}
export function SavedReviewPage({ id }: { id: string }) {
  const auth = useAuth(),
    read = useRead('ReviewSubmission', '/v1/review-submissions/' + id, !!auth.identity && !auth.loading);
  if (auth.loading) return <p role="status">Connecting your account…</p>;
  if (!auth.identity)
    return (
      <section className="panel">
        <h1>Sign in to open this result.</h1>
        <Button onClick={() => void auth.signIn()}>Sign in</Button>
      </section>
    );
  return (
    <>
      <Button variant="subtle" onClick={() => navigate('/history')}>
        Practice history
      </Button>
      {read.loading && <p role="status">Loading saved review…</p>}
      <Failure error={read.error} retry={read.reload} />
      {read.data && (
        <>
          <h1>Code Review result</h1>
          <p>
            {read.data.exerciseId} · {new Date(read.data.submittedAt).toLocaleString()} · Version{' '}
            {read.data.exerciseVersion}
          </p>
          <SavedReviewDiff result={read.data} owner={auth.identity.sub} />
          <ReviewResult result={read.data} />
        </>
      )}
    </>
  );
}

function SavedReviewDiff({ result, owner }: { result: PublicTypes['ReviewSubmission']; owner: string }) {
  const exercise = useRead('ReviewExercise', '/v1/reviews/' + result.exerciseId);
  if (exercise.loading) return <p role="status">Loading the exercise diff…</p>;
  if (!exercise.data || exercise.data.version !== result.exerciseVersion)
    return (
      <p className="muted">
        The original diff is unavailable. Your saved comments and reference findings remain below.
      </p>
    );
  return (
    <>
      <h2>{exercise.data.title}</h2>
      <p className="intro">{exercise.data.context}</p>
      <ReviewWorkspace
        key={result.id}
        exercise={exercise.data}
        owner={owner}
        result={result}
        pending={null}
        busy={false}
        submit={() => {}}
      />
    </>
  );
}
