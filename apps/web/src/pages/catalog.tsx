import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@mantine/core';
import { ArrowRight, ArrowUpRight, Database, History } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCatalog } from '../api/queries.js';
import { useWriter } from '../api/mutations.js';
import { read } from '../api/client.js';
import { useOwner } from '../api/owner.js';
import { Failure, humanize, Loading, Status } from '../components/common.js';

export function CatalogPage() {
  const catalog = useCatalog();
  const owner = useOwner();
  const attempts = useInfiniteQuery({
    queryKey: ['attempts'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      read(
        'SessionPage',
        '/v1/sessions?limit=20' + (pageParam ? '&cursor=' + encodeURIComponent(pageParam) : ''),
        undefined,
        owner,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const { submit, busy } = useWriter();
  const entries = catalog.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <main id="main" className="catalog-page">
      <header className="catalog-heading">
        <span className="eyebrow">Practice / Challenges</span>
        <h1>Practise production response.</h1>
        <p>
          Investigate the signals. Make a recovery decision.
          <br />
          See what your actions change.
        </p>
      </header>
      <div className="section-heading">
        <h2>Incident challenges</h2>
        <span className="muted">Single-player practice</span>
      </div>
      {catalog.isPending && <Loading label="Loading challenges" />}
      {catalog.isError && (
        <Failure
          error={catalog.error}
          retry={() => {
            void catalog.refetch();
          }}
        />
      )}
      <div className="challenge-list">
        {entries.map((entry, index) => (
          <article className="challenge-card" key={entry.id + entry.version}>
            <div className="challenge-number">
              {String(index + 1).padStart(2, '0')}
              <Database size={26} strokeWidth={1.4} aria-hidden="true" />
            </div>
            <div className="challenge-copy">
              <div className="challenge-meta">
                <span>{humanize(entry.domain)}</span>
                <span>{humanize(entry.difficulty ?? '')}</span>
              </div>
              <h3>{entry.title}</h3>
              <p>
                Investigate an incident, restore service, and compare your decisions in the debrief.
              </p>
              <span className="muted">Synthetic training scenario</span>
            </div>
            <Button
              disabled={busy}
              rightSection={<ArrowUpRight size={17} />}
              onClick={() =>
                submit({
                  kind: 'start',
                  label: 'Start ' + entry.title,
                  body: {
                    requestId: crypto.randomUUID(),
                    contentId: entry.id,
                    contentVersion: entry.version,
                  },
                })
              }
            >
              Start challenge
            </Button>
          </article>
        ))}
      </div>
      {catalog.hasNextPage && (
        <Button
          variant="default"
          loading={catalog.isFetchingNextPage}
          onClick={() => {
            void catalog.fetchNextPage();
          }}
        >
          More challenges
        </Button>
      )}
      {catalog.isSuccess && entries.length === 0 && (
        <p className="empty-copy">No challenges are available.</p>
      )}
      <section className="attempts-section">
        <div className="section-heading">
          <h2>
            <History size={18} aria-hidden="true" /> Your attempts
          </h2>
          <span className="muted">Progress is saved after each action</span>
        </div>
        {attempts.isPending && <Loading label="Loading attempts" />}
        {attempts.isError && (
          <Failure
            error={attempts.error}
            retry={() => {
              void attempts.refetch();
            }}
          />
        )}
        {attempts.isSuccess && attempts.data.pages[0]?.items.length === 0 && (
          <div className="empty-attempts">
            <h3>Your first investigation starts here.</h3>
            <p>Start a challenge above. You can return to it at any time.</p>
          </div>
        )}
        <div className="attempt-list">
          {attempts.data?.pages
            .flatMap((page) => page.items)
            .map((attempt) => (
              <Link key={attempt.id} to={'/challenges/' + attempt.id} className="attempt-row">
                <div>
                  <strong>
                    {entries.find((entry) => entry.id === attempt.contentId)?.title ??
                      humanize(attempt.contentId)}
                  </strong>
                  <span>
                    {attempt.mode === 'replay' ? 'Informed replay' : 'First attempt'} ·{' '}
                    {new Date(attempt.createdAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </div>
                <Status status={attempt.status} />
                <ArrowRight
                  size={18}
                  aria-label={attempt.status === 'active' ? 'Continue attempt' : 'View debrief'}
                />
              </Link>
            ))}
        </div>
        {attempts.hasNextPage && (
          <Button
            variant="default"
            mt="lg"
            loading={attempts.isFetchingNextPage}
            onClick={() => {
              void attempts.fetchNextPage();
            }}
          >
            Older attempts
          </Button>
        )}
      </section>
    </main>
  );
}
