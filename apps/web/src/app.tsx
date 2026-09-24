import { Component, lazy, Suspense, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@mantine/core';
import { Activity, ArrowRight, LogOut } from 'lucide-react';
import { Link, Route, Routes } from 'react-router-dom';
import { currentAccount, localAccounts, request } from './api/client.js';
import { MutationProvider } from './api/mutations.js';
import { OwnerContext } from './api/owner.js';
import { createLearnerClient } from './api/cache.js';
import { Failure, Loading } from './components/common.js';
const CatalogPage = lazy(() =>
  import('./pages/catalog.js').then((module) => ({ default: module.CatalogPage })),
);
const ChallengePage = lazy(() =>
  import('./pages/challenge.js').then((module) => ({ default: module.ChallengePage })),
);

export class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <main className="fatal-error">
          <h1>The workspace could not open.</h1>
          <p>
            Your saved server progress is unchanged. Reload to reconnect. If the error continues,
            check the local setup guide.
          </p>
          <Button onClick={() => location.reload()}>Reload workspace</Button>
        </main>
      );
    return this.props.children;
  }
}

export function App() {
  const client = useQueryClient();
  const identity = useQuery({ queryKey: ['account'], queryFn: currentAccount, staleTime: 0 });
  const [authError, setAuthError] = useState<Error | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  async function logout() {
    setSigningOut(true);
    try {
      await request('/dev/logout', {});
      client.clear();
      await client.invalidateQueries();
      location.assign('/');
    } catch (error) {
      setAuthError(error instanceof Error ? error : new Error('Unable to sign out.'));
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <Link to="/" className="wordmark" aria-label="OpsReplay home">
          <span className="brand-mark">
            <Activity size={21} strokeWidth={1.8} />
          </span>
          OpsReplay
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/" aria-current="page">
            Challenges
          </Link>
        </nav>
        <div className="account-control">
          <span className="local-label">Local workspace</span>
          {identity.data && (
            <>
              <span className="account-name">{identity.data.name}</span>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                aria-label="Sign out"
                loading={signingOut}
                onClick={() => {
                  void logout();
                }}
              >
                <LogOut size={15} />
              </Button>
            </>
          )}
        </div>
      </header>
      {authError && (
        <Failure
          error={authError}
          retry={() => {
            void logout();
          }}
        />
      )}
      {identity.isPending ? (
        <Loading label="Connecting to workspace" />
      ) : identity.isError ? (
        <Failure
          error={identity.error}
          retry={() => {
            void identity.refetch();
          }}
        />
      ) : !identity.data ? (
        <Login />
      ) : (
        <LearnerWorkspace
          key={identity.data.id}
          ownerId={identity.data.id}
          onIdentityChanged={() => {
            void identity.refetch();
          }}
        >
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<CatalogPage />} />
              <Route path="/challenges/:id" element={<ChallengePage />} />
              <Route
                path="*"
                element={
                  <main id="main" className="fatal-error">
                    <h1>Page not found</h1>
                    <Link to="/">Return to challenges</Link>
                  </main>
                }
              />
            </Routes>
          </Suspense>
        </LearnerWorkspace>
      )}
      <footer className="app-footer">
        <span>OpsReplay</span>
        <span>Learn production failures by investigating them.</span>
      </footer>
    </>
  );
}

function Login() {
  const accounts = useQuery({ queryKey: ['local-accounts'], queryFn: localAccounts });
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  async function login(id: string) {
    setPending(id);
    setError(null);
    try {
      await request('/dev/login', { accountId: id });
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'account' });
      await client.invalidateQueries({ queryKey: ['account'] });
    } catch (error) {
      setError(error instanceof Error ? error : new Error('Unable to sign in.'));
    } finally {
      setPending(null);
    }
  }
  return (
    <main id="main" className="login-page">
      <span className="eyebrow">Your practice workspace</span>
      <h1>Ready for the next incident?</h1>
      <p>
        Choose a local learner to keep your investigations
        <br className="desktop-break" /> and replay history together.
      </p>
      <div className="login-accounts">
        {accounts.isPending && <Loading label="Loading learners" />}
        {accounts.isError && (
          <Failure
            error={accounts.error}
            retry={() => {
              void accounts.refetch();
            }}
          />
        )}
        {accounts.data?.map((account, index) => (
          <Button
            key={account.id}
            variant="default"
            size="lg"
            fullWidth
            justify="space-between"
            loading={pending === account.id}
            disabled={pending !== null && pending !== account.id}
            leftSection={<span className="account-avatar">{index + 1}</span>}
            rightSection={<ArrowRight size={18} />}
            onClick={() => {
              void login(account.id);
            }}
          >
            {account.name}
          </Button>
        ))}
      </div>
      {error && (
        <Failure
          error={error}
          retry={() => {
            void accounts.refetch();
            setError(null);
          }}
        />
      )}
      <p className="login-note">Local development accounts. No password is required.</p>
    </main>
  );
}

function LearnerWorkspace({
  ownerId,
  onIdentityChanged,
  children,
}: {
  ownerId: string;
  onIdentityChanged: () => void;
  children: ReactNode;
}) {
  const [client] = useState(createLearnerClient);
  return (
    <OwnerContext value={ownerId}>
      <QueryClientProvider client={client}>
        <MutationProvider ownerId={ownerId} onIdentityChanged={onIdentityChanged}>
          {children}
        </MutationProvider>
      </QueryClientProvider>
    </OwnerContext>
  );
}
