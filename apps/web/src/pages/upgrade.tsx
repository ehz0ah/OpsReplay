import { Button } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { useRead } from '../use-read.js';
import { useAlive } from '../use-alive.js';
import { MutationJournal } from '../mutation-journal.js';
import { activateDemoUpgrade, demoUpgradeAvailable, accessDeadline } from '../demo-upgrade.js';
import { WorkingState } from '../components/working-state.js';
import { Failure } from '../components/failure.js';
import { navigate } from '../navigation.js';

export function UpgradePage() {
  const auth = useAuth(),
    api = useApi(),
    alive = useAlive();
  const account = useRead('Account', '/v1/me', !!auth.identity && !auth.loading);
  const journal = useMemo(
    () => (auth.identity ? new MutationJournal(sessionStorage, auth.identity.sub) : null),
    [auth.identity?.sub],
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [completed, setCompleted] = useState(false);
  async function activate() {
    if (!journal || busy || !account.data || !demoUpgradeAvailable(account.data)) return;
    setBusy(true);
    setError(null);
    try {
      await activateDemoUpgrade(api, journal);
      if (alive.current) {
        setCompleted(true);
        account.reload();
      }
    } catch (value) {
      if (alive.current) {
        setError(value instanceof Error ? value : new Error('Demo activation could not finish.'));
        account.reload();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="saas-page upgrade-page">
      <a className="back-link" href="/pricing">
        Back to pricing
      </a>
      <header className="saas-heading">
        <p className="eyebrow">Demo checkout</p>
        <h1>
          More practice.
          <br />
          No payment today.
        </h1>
      </header>
      <div className="upgrade-grid">
        <section className="upgrade-summary" aria-labelledby="upgrade-summary-heading">
          <h2 id="upgrade-summary-heading">Pro access</h2>
          <dl>
            <div>
              <dt>Proposed subscription</dt>
              <dd>S$12 / month</dd>
            </div>
            <div>
              <dt>Due today</dt>
              <dd>S$0</dd>
            </div>
            <div>
              <dt>Billing</dt>
              <dd>Not connected</dd>
            </div>
          </dl>
          <p>
            No payment collected. One fixed presentation window. No card details, subscription or automatic renewal.
          </p>
          <p>Your current attempt, results and recordings do not change.</p>
        </section>
        <section className="upgrade-action" aria-labelledby="upgrade-action-heading">
          <h2 id="upgrade-action-heading">Confirm your demo access</h2>
          {auth.loading || account.loading ? (
            <WorkingState title="Checking account access" />
          ) : !auth.identity ? (
            <>
              <p>Sign in or create an account. Demo activation is limited to operator-approved learners.</p>
              <div className="actions">
                <Button onClick={() => void auth.signIn()}>Sign in</Button>
                <Button variant="default" onClick={() => void auth.signUp()}>
                  Create account
                </Button>
              </div>
            </>
          ) : account.data?.plan === 'pro' ? (
            <div role="status">
              <h3>Pro access is active</h3>
              <p>{accessDeadline(account.data.planExpiresAt)}</p>
              <p>{completed ? 'The server has confirmed your access.' : 'Your existing grant is unchanged.'}</p>
              <div className="actions">
                <Button onClick={() => navigate('/challenges')}>Explore Pro Challenges</Button>
                <Button variant="default" onClick={() => navigate('/account')}>
                  View account
                </Button>
              </div>
            </div>
          ) : account.data && demoUpgradeAvailable(account.data) ? (
            <>
              <p>
                Demo Pro expires {accessDeadline(account.data.demoUpgradeExpiresAt)}. Repeating activation does not
                extend this window.
              </p>
              <Button loading={busy} disabled={busy} onClick={() => void activate()}>
                {error ? 'Try activation again' : 'Activate demo Pro'}
              </Button>
              <p className="muted">This changes your server-owned access. It does not start a Challenge.</p>
            </>
          ) : account.data ? (
            <div role="status">
              <h3>Demo activation is unavailable</h3>
              <p>
                This account is not approved, the window has ended, or demo activation is disabled. Free access remains
                available.
              </p>
              <Button variant="default" onClick={() => navigate('/challenges')}>
                Explore Free Challenges
              </Button>
            </div>
          ) : null}
          <Failure error={account.data?.plan === 'pro' ? null : error} />
          <Failure error={account.error} retry={account.reload} />
          {auth.identity && !account.loading && (
            <Button variant="subtle" disabled={busy} onClick={account.reload}>
              Refresh access
            </Button>
          )}
        </section>
      </div>
    </div>
  );
}
