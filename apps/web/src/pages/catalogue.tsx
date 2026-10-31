import { Badge, Button, Modal, Select, TextInput } from '@mantine/core';
import { ActiveAttempt } from '../components/attempt-notice.js';
import { WorkingState } from '../components/working-state.js';
import { AttemptRules, ChallengeBriefing } from '../components/challenge-briefing.js';
import { useAlive } from '../use-alive.js';
import { startAttempt } from '../start-attempt.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { ApiError } from '../api.js';
import { useRead } from '../use-read.js';
import { MutationJournal, type PendingMutation } from '../mutation-journal.js';
import { navigate } from '../navigation.js';
import { Failure } from '../components/failure.js';
export function CataloguePage() {
  const alive = useAlive();
  const auth = useAuth(),
    api = useApi();
  const [filters, setFilters] = useState({ tier: '', category: '', plan: '' }),
    [cursor, setCursor] = useState<string | null>(null);
  const query = new URLSearchParams({ mode: 'challenge', limit: '50' });
  for (const [name, value] of Object.entries(filters)) if (value) query.set(name, value);
  if (cursor) query.set('cursor', cursor);
  const catalog = useRead('Catalog', '/v1/catalog?' + query),
    account = useRead('Account', '/v1/me', !!auth.identity && !auth.loading);
  const journal = useMemo(
    () => (auth.identity ? new MutationJournal(sessionStorage, auth.identity.sub) : null),
    [auth.identity?.sub],
  );
  const [pending, setPending] = useState<PendingMutation | null>(() => {
    try {
      return journal?.load('start', '/v1/sessions') ?? null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<PublicTypes['CatalogEntry'] | null>(null),
    [error, setError] = useState<Error | null>(null),
    [retryAt, setRetryAt] = useState(0);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const visibleEntries = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (catalog.data?.items ?? []).filter((entry) =>
      words.every((word) => [entry.title, entry.summary, entry.category].join(' ').toLowerCase().includes(word)),
    );
  }, [catalog.data, search]);
  const hasFilters = !!search || Object.values(filters).some(Boolean);
  function clearFilters() {
    setSearch('');
    setFilters({ tier: '', category: '', plan: '' });
    setCursor(null);
    searchInput.current?.focus();
  }
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const cooldown = retryAt > clock;
  async function start(entry: PublicTypes['CatalogEntry'] | null) {
    if (!auth.identity) {
      await auth.signIn();
      return;
    }
    if (!journal || busy || cooldown || !account.data) return;
    if (account.data.activeSessionId && !pending) {
      navigate('/sessions/' + account.data.activeSessionId);
      return;
    }
    setBusy(true);
    setError(null);
    let request: PendingMutation | null = null;
    try {
      request = entry
        ? journal.begin({
            kind: 'start',
            path: '/v1/sessions',
            body: { requestId: crypto.randomUUID(), challengeId: entry.id, challengeVersion: entry.version },
          })
        : journal.load('start', '/v1/sessions');
      if (!request || request.kind !== 'start') throw new Error('There is no start request to recover.');
      setPending(request);
      const result = await startAttempt(api, journal, request);
      if (!alive.current) return;
      setPending(null);
      account.reload();
      navigate('/sessions/' + result.id);
    } catch (value) {
      if (!alive.current) return;
      if (request) journal.reject(request, value);
      try {
        setPending(journal.load('start', '/v1/sessions'));
      } catch {
        /* Keep invalid saved requests blocked. */
      }
      const failure = value instanceof Error ? value : new Error('The Challenge could not start.');
      setError(failure);
      if (failure instanceof ApiError) {
        if (failure.detail.activeSessionId) {
          account.reload();
          navigate('/sessions/' + failure.detail.activeSessionId);
        }
        if (failure.detail.retryAfterSeconds) {
          setClock(Date.now());
          setRetryAt(Date.now() + failure.detail.retryAfterSeconds * 1000);
        }
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <Modal
        opened={selected !== null}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        title={selected?.title ?? 'Challenge briefing'}
        size="lg"
        classNames={{ content: 'lab-modal', header: 'lab-modal-header' }}
        centered
      >
        {selected && (
          <>
            <p className="briefing-clock">
              The clock starts when the environment is ready. Leaving the workspace does not pause it.
            </p>
            <div className="lab-briefing-scroll" role="region" aria-label="Challenge reference and rules" tabIndex={0}>
              <ChallengeBriefing
                key={selected.id + '@' + selected.version}
                id={selected.id}
                version={selected.version}
              />
              <AttemptRules />
            </div>
            <div className="actions briefing-actions">
              <Button variant="default" disabled={busy} onClick={() => setSelected(null)}>
                Back to Challenges
              </Button>
              <Button
                className="lab-modal-start"
                loading={busy}
                disabled={
                  cooldown ||
                  !!pending ||
                  auth.loading ||
                  (!!auth.identity && !account.data) ||
                  (selected.plan === 'pro' && account.data?.plan !== 'pro' && !!auth.identity)
                }
                onClick={() => void start(selected)}
              >
                {!auth.identity
                  ? 'Sign in to start'
                  : selected.plan === 'pro' && account.data?.plan !== 'pro'
                    ? 'Pro required'
                    : account.data?.activeSessionId
                      ? 'Resume current attempt'
                      : 'Start Challenge'}
              </Button>
            </div>
            <Failure error={error} />
            <Failure error={account.error} retry={account.reload} />
            {selected.plan === 'pro' && account.data?.plan === 'free' && (
              <p className="notice">
                This Challenge needs Pro access. <a href="/upgrade">View the demo upgrade</a>. Your current attempt is
                preserved.
              </p>
            )}
            {account.loading && auth.identity && <WorkingState title="Loading your account" />}
            {cooldown && <p role="status">Try again in {Math.max(1, Math.ceil((retryAt - clock) / 1000))} seconds.</p>}
            {pending && !busy && (
              <div className="notice" role="status">
                <p>The start response is uncertain. Recover the same request before starting another attempt.</p>
                <Button disabled={cooldown || !account.data} onClick={() => void start(null)}>
                  Recover start request
                </Button>
              </div>
            )}
            {busy && (
              <WorkingState title="Confirming your start request">
                Your environment will open automatically. Keep this page open until the request is confirmed.
              </WorkingState>
            )}
          </>
        )}
      </Modal>
      <div className="lab-width lab-catalogue">
        <div className="lab-catalogue-heading">
          <div>
            <a className="lab-back-link" href="/">
              ← Back to the lab
            </a>
            <h1>
              Choose your
              <br />
              <span className="lab-marker">next bad day.</span>
            </h1>
            <p>Investigate real services. Repair the fault. Replay your response.</p>
          </div>
          <div className="lab-stamp" aria-hidden="true">
            <span>
              REAL
              <br />
              SERVICES.
            </span>
            <span>
              YOUR
              <br />
              RESPONSE.
            </span>
            <strong>↺</strong>
          </div>
        </div>
        {account.data && (
          <div className="lab-access">
            <div>
              <strong>{account.data.plan === 'pro' ? 'Pro' : 'Free'} access</strong>
              <p>Your account controls new content access. Existing attempts retain their saved access.</p>
            </div>
            <a className="lab-text-link" href="/pricing">
              Compare access ↗
            </a>
          </div>
        )}
        {account.data?.activeSessionId && !pending && (
          <ActiveAttempt key={account.data.activeSessionId} id={account.data.activeSessionId} />
        )}
        {account.loading && <WorkingState title="Loading your account" />}
        <Failure error={account.error} retry={account.reload} />
        {account.error instanceof ApiError && account.error.status === 401 && (
          <Button onClick={() => void auth.signIn()}>Sign in again</Button>
        )}
        <div className="lab-filters">
          <TextInput
            ref={searchInput}
            className="lab-search"
            label="Search this page"
            placeholder="Search by title or category"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
          {(['tier', 'plan', 'category'] as const).map((name) => (
            <Select
              className={name === 'category' ? 'lab-category-filter' : undefined}
              classNames={{ dropdown: 'lab-filter-dropdown', option: 'lab-filter-option' }}
              key={name}
              label={name === 'tier' ? 'Difficulty' : name === 'category' ? 'Category' : 'Access'}
              value={filters[name]}
              allowDeselect={false}
              onChange={(value) => {
                setFilters((current) => ({ ...current, [name]: value ?? '' }));
                setCursor(null);
              }}
              data={[
                'All',
                ...(name === 'tier'
                  ? (catalog.data?.availableFilters.tiers ?? [])
                  : name === 'category'
                    ? (catalog.data?.availableFilters.categories ?? [])
                    : (catalog.data?.availableFilters.plans ?? [])),
              ].map((v, i) => ({
                value: i === 0 ? '' : v,
                label: v === 'dns' ? 'DNS' : v.charAt(0).toUpperCase() + v.slice(1),
              }))}
            />
          ))}
        </div>
        <div className="lab-filter-actions">
          {hasFilters && (
            <button className="lab-clear" type="button" onClick={clearFilters}>
              Clear filters ↺
            </button>
          )}
        </div>
        {catalog.loading && (
          <div className="lab-catalogue-loading">
            <WorkingState title="Loading published Challenges" />
            <div className="lab-loading-shape" aria-hidden="true">
              <span />
              <div>
                <i />
                <i />
                <i />
              </div>
            </div>
          </div>
        )}
        <Failure
          error={catalog.error}
          retry={() => {
            setCursor(null);
            catalog.reload();
          }}
        />
        <Failure error={error} />
        {cooldown && <p role="status">Try again in {Math.max(1, Math.ceil((retryAt - clock) / 1000))} seconds.</p>}
        {pending && (
          <div className="notice">
            <p>A start request is waiting for confirmation. Retry the same request to recover its result.</p>
            <Button loading={busy} disabled={cooldown || !account.data} onClick={() => void start(null)}>
              Recover start request
            </Button>
          </div>
        )}
        {catalog.data && !catalog.loading && (
          <>
            <div className="lab-result-heading">
              <p role="status" aria-live="polite">
                {visibleEntries.length} {visibleEntries.length === 1 ? 'Challenge' : 'Challenges'}
                {cursor || catalog.data.nextCursor ? ' on this page' : ''}
              </p>
              <span>Debrief + playback included</span>
            </div>
            <div className="lab-challenge-list">
              {visibleEntries.map((entry) => (
                <article className="lab-challenge-card" key={entry.id + '@' + entry.version}>
                  <div className={`lab-challenge-art${entry.plan === 'pro' ? ' lab-art-blue' : ''}`} aria-hidden="true">
                    <span>
                      {entry.category === 'dns'
                        ? 'DNS'
                        : entry.category.charAt(0).toUpperCase() + entry.category.slice(1)}
                    </span>
                    <div className="lab-route-art">
                      <span>→</span>
                      <strong>?</strong>
                      <span>↗</span>
                    </div>
                    <p>Follow the evidence.</p>
                  </div>
                  <div className="lab-challenge-content">
                    <div className="lab-tags">
                      {entry.tier && (
                        <Badge variant="outline" color="dark">
                          {entry.tier.charAt(0).toUpperCase() + entry.tier.slice(1)}
                        </Badge>
                      )}
                      <Badge variant="filled" className={entry.plan === 'pro' ? 'lab-pro-tag' : 'lab-free-tag'}>
                        {entry.plan === 'pro' ? 'Pro' : 'Free'}
                      </Badge>
                      <span>
                        {entry.category === 'dns'
                          ? 'DNS'
                          : entry.category.charAt(0).toUpperCase() + entry.category.slice(1)}
                      </span>
                    </div>
                    <h2>{entry.title}</h2>
                    <p>{entry.summary}</p>
                    <div className="lab-challenge-bottom">
                      <span>Debrief + playback</span>
                      <Button
                        className="lab-button lab-button-ink"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setSelected(entry);
                        }}
                      >
                        Read briefing <span aria-hidden="true">↗</span>
                      </Button>
                    </div>
                    {entry.plan === 'pro' && account.data?.plan !== 'pro' && (
                      <p className="lab-lock-note">
                        Included with Pro. You can read the briefing before choosing access.
                      </p>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {visibleEntries.length === 0 && (
              <section className="lab-empty">
                <span aria-hidden="true">?</span>
                <h2>No matching Challenges.</h2>
                <p>
                  {hasFilters
                    ? 'Try another search or clear the filters.'
                    : 'No Challenges are published here yet. Try again later.'}
                </p>
                {hasFilters && (
                  <Button className="lab-button lab-button-yellow" onClick={clearFilters}>
                    Clear filters ↺
                  </Button>
                )}
              </section>
            )}
            <div className="actions lab-pagination">
              {catalog.data.nextCursor && (
                <Button variant="default" disabled={busy} onClick={() => setCursor(catalog.data!.nextCursor)}>
                  Next page
                </Button>
              )}
              {cursor && (
                <Button variant="default" disabled={busy} onClick={() => setCursor(null)}>
                  First page
                </Button>
              )}
            </div>
          </>
        )}
        <aside className="lab-practice-note">
          <span aria-hidden="true">↺</span>
          <div>
            <h2>The replay is part of the practice.</h2>
            <p>
              Review the causal debrief and your recorded response. A retry starts in a fresh environment and preserves
              your first result.
            </p>
          </div>
        </aside>
        <section className="lab-access-callout">
          <div>
            <h2>
              A longer run.
              <br />A different failure.
            </h2>
            <p>Compare published content and session access. The demo upgrade collects no payment.</p>
          </div>
          <Button className="lab-button lab-button-yellow" onClick={() => navigate('/pricing')}>
            Compare access <span aria-hidden="true">↗</span>
          </Button>
        </section>
      </div>
    </>
  );
}
