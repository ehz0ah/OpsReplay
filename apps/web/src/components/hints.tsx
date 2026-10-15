import { useEffect, useMemo, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useApi } from '../api-context.js';
import { useAuth } from '../auth/provider.js';
import { useAlive } from '../use-alive.js';
import { MutationJournal } from '../mutation-journal.js';
import { releaseHint } from '../hint-attempt.js';
import { Failure } from './failure.js';
import { ApiError } from '../api.js';
export function Hints({
  view,
  now,
  refresh,
  disabled,
}: {
  view: PublicTypes['SessionView'];
  now: number;
  refresh: () => void;
  disabled: boolean;
}) {
  const api = useApi(),
    auth = useAuth(),
    alive = useAlive(),
    journal = useMemo(() => new MutationJournal(sessionStorage, auth.identity!.sub), [auth.identity?.sub]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [released, setReleased] = useState<PublicTypes['Hint'][]>([]),
    [pending, setPending] = useState(false),
    [retryAt, setRetryAt] = useState(0);
  useEffect(() => {
    try {
      setPending(Boolean(journal.load('hint', `/v1/sessions/${view.id}/hints`)));
    } catch (value) {
      setError(value as Error);
    }
  }, [journal, view.id]);
  const hints = [...new Map([...view.hints.released, ...released].map((hint) => [hint.id, hint])).values()];
  const wait = Math.max(
    0,
    Math.ceil((Math.max(Date.parse(view.hints.nextAvailableAt ?? '') || 0, retryAt) - now) / 1000),
  );
  async function request() {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const result = await releaseHint(api, journal, view.id);
      if (alive.current) {
        setReleased((current) => [...current, result.hint]);
        setPending(false);
        refresh();
      }
    } catch (value) {
      if (alive.current) {
        const failure = value instanceof Error ? value : new Error('Hint delivery is uncertain.');
        setError(failure);
        if (failure instanceof ApiError) setRetryAt(Date.now() + (failure.detail.retryAfterSeconds ?? 0) * 1000);
        try {
          setPending(Boolean(journal.load('hint', `/v1/sessions/${view.id}/hints`)));
        } catch {
          setPending(true);
        }
        refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h2>Hints</h2>
      <p className="muted">Hints count as assistance. Only released hints appear here.</p>
      {hints.map((hint) => (
        <p key={hint.id}>{hint.text}</p>
      ))}
      <Failure error={error} />
      <button
        className="secondary"
        disabled={disabled || busy || (!pending && (view.hints.remaining === 0 || wait > 0)) || now < retryAt}
        onClick={() => void request()}
      >
        {busy
          ? 'Releasing hint…'
          : pending
            ? 'Recover hint request'
            : wait > 0
              ? `Next hint in ${wait}s`
              : view.hints.remaining === 0
                ? 'No hints remain'
                : 'Release next hint'}
      </button>
    </section>
  );
}
