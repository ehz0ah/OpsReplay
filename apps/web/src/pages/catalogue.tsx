import { Badge, Button, Modal, NativeSelect } from '@mantine/core';
import { AttemptRules, ChallengeBriefing } from '../components/challenge-briefing.js';
import { useAlive } from '../use-alive.js';
import { startAttempt } from '../start-attempt.js';
import { useEffect, useMemo, useState } from 'react';
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
        centered
      >
        {selected && (
          <>
            <AttemptRules />
            <ChallengeBriefing key={selected.id + '@' + selected.version} id={selected.id} version={selected.version} />
            <div className="actions briefing-actions">
              <Button variant="default" disabled={busy} onClick={() => setSelected(null)}>
                Back to Challenges
              </Button>
              <Button
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
            {pending && !busy && (
              <div className="notice" role="status">
                <p>The start response is uncertain. Recover the same request before starting another attempt.</p>
                <Button disabled={cooldown || !account.data} onClick={() => void start(null)}>
                  Recover start request
                </Button>
              </div>
            )}
            {busy && <p role="status">Confirming your start request. Your environment will open automatically.</p>}
          </>
        )}
      </Modal>
      <div className="actions">
        <h2>Challenges</h2>
        {account.data && <span className="badge">{account.data.plan === 'pro' ? 'Pro' : 'Free'} access</span>}
      </div>
      {account.data?.activeSessionId && !pending && (
        <div className="notice">
          <p>You have an attempt in progress or awaiting cleanup.</p>
          <Button onClick={() => navigate('/sessions/' + account.data!.activeSessionId)}>Resume attempt</Button>
        </div>
      )}
      {account.loading && <p role="status">Loading your account…</p>}
      <Failure error={account.error} retry={account.reload} />
      {account.error instanceof ApiError && account.error.status === 401 && (
        <Button onClick={() => void auth.signIn()}>Sign in again</Button>
      )}
      <div className="actions">
        {(['tier', 'category', 'plan'] as const).map((name) => (
          <NativeSelect
            key={name}
            label={name === 'tier' ? 'Difficulty' : name === 'category' ? 'Category' : 'Access'}
            value={filters[name]}
            onChange={(e) => {
              setFilters({ ...filters, [name]: e.currentTarget.value });
              setCursor(null);
            }}
            data={[
              'All',
              ...(name === 'tier'
                ? (catalog.data?.availableFilters.tiers ?? [])
                : name === 'category'
                  ? (catalog.data?.availableFilters.categories ?? [])
                  : (catalog.data?.availableFilters.plans ?? [])),
            ].map((v, i) => ({ value: i === 0 ? '' : v, label: v }))}
          />
        ))}
      </div>
      {catalog.loading && <p role="status">Loading published Challenges…</p>}
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
          <Button disabled={busy || cooldown || !account.data} onClick={() => void start(null)}>
            Recover start request
          </Button>
        </div>
      )}
      {catalog.data?.items.map((entry) => (
        <article className="challenge-row" key={entry.id + '@' + entry.version}>
          <div>
            <div className="actions">
              <Badge variant="light" color="gray">
                {entry.tier}
              </Badge>
              <span className="content-category">{entry.category}</span>
              <span className="content-category">{entry.plan}</span>
            </div>
            <h3>{entry.title}</h3>
            <p className="muted">{entry.summary}</p>
          </div>
          <Button
            disabled={busy}
            onClick={() => {
              setError(null);
              setSelected(entry);
            }}
          >
            Read briefing
          </Button>
        </article>
      ))}
      {catalog.data?.items.length === 0 && <p className="muted">No published Challenges match these filters.</p>}
      {catalog.data?.nextCursor && (
        <Button variant="default" onClick={() => setCursor(catalog.data!.nextCursor)}>
          Next page
        </Button>
      )}
      {cursor && (
        <Button variant="default" onClick={() => setCursor(null)}>
          First page
        </Button>
      )}
    </>
  );
}
