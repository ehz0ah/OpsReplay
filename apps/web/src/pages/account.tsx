import { Button } from '@mantine/core';
import { useAuth } from '../auth/provider.js';
import { useRead } from '../use-read.js';
import { WorkingState } from '../components/working-state.js';
import { Failure } from '../components/failure.js';
import { navigate } from '../navigation.js';
import { accessDeadline } from '../demo-upgrade.js';

export function AccountPage() {
  const auth = useAuth();
  const account = useRead('Account', '/v1/me', !!auth.identity && !auth.loading);
  return (
    <div className="saas-page account-page">
      <header className="saas-heading">
        <p className="eyebrow">Your workspace</p>
        <h1>Account and access</h1>
      </header>
      {auth.loading || account.loading ? (
        <WorkingState title="Reading your access" />
      ) : !auth.identity ? (
        <section className="panel">
          <h2>Sign in to view your account.</h2>
          <p>Your access comes from the server, not this browser.</p>
          <div className="actions">
            <Button onClick={() => void auth.signIn()}>Sign in</Button>
            <Button variant="default" onClick={() => void auth.signUp()}>
              Create account
            </Button>
          </div>
        </section>
      ) : account.data ? (
        <section className="account-access" aria-labelledby="access-heading">
          <p className="eyebrow">Current plan</p>
          <h2 id="access-heading">{account.data.plan === 'pro' ? 'Pro' : 'Free'} access</h2>
          <p>
            {account.data.plan === 'pro'
              ? accessDeadline(account.data.planExpiresAt)
              : 'Start with the Free content set.'}
          </p>
          <p className="muted">Prototype access grant. No payment or recurring subscription.</p>
          <div className="actions">
            <Button onClick={() => navigate('/challenges')}>Explore Challenges</Button>
            {account.data.plan === 'free' && (
              <Button variant="default" onClick={() => navigate('/upgrade')}>
                View demo upgrade
              </Button>
            )}
            <Button variant="subtle" onClick={account.reload}>
              Refresh access
            </Button>
          </div>
          {account.data.activeSessionId && (
            <p>
              <a href={'/sessions/' + account.data.activeSessionId}>Resume your current attempt</a>
            </p>
          )}
        </section>
      ) : null}
      <Failure error={account.error} retry={account.reload} />
      <section className="pricing-notes">
        <h2>Your work stays yours</h2>
        <p>
          Changing access does not restart your current attempt or rewrite its score. Saved results remain in History.
        </p>
        <a href="/history">Open History</a>
      </section>
    </div>
  );
}
