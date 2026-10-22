import { Button } from '@mantine/core';
import { useEffect, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { useRead } from '../use-read.js';
import { navigate } from '../navigation.js';
import { Failure } from '../components/failure.js';
import { WorkingState } from '../components/working-state.js';
import { lessonCatalogueState, readFreeLesson, readFreeLessonIndex, type FreeLessonSummary } from '../learn.js';
export function LearnCatalogue() {
  const catalogue = useRead('Catalog', '/v1/catalog?mode=learn&limit=100');
  const [free, setFree] = useState<FreeLessonSummary[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [freeLoading, setFreeLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setFreeLoading(true);
    void readFreeLessonIndex(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setFree(value);
      })
      .catch((value) => {
        if (!controller.signal.aborted) setError(value instanceof Error ? value : new Error('Lessons unavailable.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFreeLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  const entries = new Map<string, FreeLessonSummary & { plan: 'free' | 'pro' }>(
    free.map((entry) => [entry.id, { ...entry, plan: 'free' as const }]),
  );
  for (const entry of catalogue.data?.items ?? []) if (!entries.has(entry.id)) entries.set(entry.id, entry);
  const state = lessonCatalogueState(entries.size, freeLoading || catalogue.loading, error || catalogue.error);
  return (
    <>
      <p className="eyebrow">Learn</p>
      <h1>Understand the failure.</h1>
      <p className="intro">Read an incident explanation, examine its lessons, then practise in a Challenge.</p>
      <Failure error={error} retry={() => setRevision((value) => value + 1)} />
      <Failure error={catalogue.error} retry={catalogue.reload} />
      {state === 'loading' && <WorkingState title="Loading lessons" />}
      {[...entries.values()].map((entry) => (
        <article className="challenge-row" key={entry.id}>
          <div>
            <span className="content-category">
              {entry.category} · {entry.plan}
            </span>
            <h2>{entry.title}</h2>
            <p>{entry.summary}</p>
          </div>
          <Button variant="default" onClick={() => navigate('/learn/' + entry.id)}>
            Read lesson
          </Button>
        </article>
      ))}
      {state === 'empty' && <p>No lessons are available.</p>}
    </>
  );
}
export function LearnPage({ id }: { id: string }) {
  const api = useApi(),
    auth = useAuth();
  const [entry, setEntry] = useState<PublicTypes['LearnEntry'] | null>(null);
  const [error, setError] = useState<Error | null>(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setEntry(null);
    setError(null);
    setLoading(true);
    void (async () => {
      const free = await readFreeLesson(id, controller.signal);
      if (free) return free;
      if (auth.loading) return null;
      if (!auth.identity) throw new Error('Sign in to read a protected lesson.');
      return api.read('LearnEntry', '/v1/learn/' + id, controller.signal);
    })()
      .then((value) => {
        if (!controller.signal.aborted) setEntry(value);
      })
      .catch((value) => {
        if (!controller.signal.aborted) setError(value instanceof Error ? value : new Error('Lesson unavailable.'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, api, auth.identity?.sub, auth.loading]);
  return (
    <>
      <Button variant="subtle" onClick={() => navigate('/learn')}>
        All lessons
      </Button>
      {loading && <p role="status">Opening lesson…</p>}
      <Failure error={error} />
      {error && !auth.identity && <Button onClick={() => void auth.signIn()}>Sign in</Button>}
      {entry && (
        <article className="lesson">
          <p className="eyebrow">
            {entry.category} · {entry.plan}
          </p>
          <h1>{entry.title}</h1>
          <p className="intro">{entry.summary}</p>
          {/* Only the authored, sanitised Learn HTML contract reaches this renderer. */}
          <div className="lesson-body" dangerouslySetInnerHTML={{ __html: entry.html }} />
          <section>
            <h2>Lessons to carry forward</h2>
            <ul>
              {entry.lessons.map((lesson) => (
                <li key={lesson}>{lesson}</li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Original sources</h2>
            <ul>
              {entry.sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} rel="noopener noreferrer">
                    {source.title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
          {!!entry.relatedExercises.length && (
            <section>
              <h2>Practise this skill</h2>
              {entry.relatedExercises.map((exercise) => (
                <p key={exercise.mode + exercise.id}>
                  <a
                    href={exercise.mode === 'challenge' ? '/challenges' : '/reviews/' + exercise.id}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(exercise.mode === 'challenge' ? '/challenges' : '/reviews/' + exercise.id);
                    }}
                  >
                    {exercise.title}
                  </a>
                </p>
              ))}
            </section>
          )}
        </article>
      )}
    </>
  );
}
