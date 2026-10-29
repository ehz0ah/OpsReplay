import { Button } from '@mantine/core';
import { lazy, Suspense } from 'react';
const DebriefPage = lazy(() => import('./pages/debrief.js').then((module) => ({ default: module.DebriefPage })));
const PricingPage = lazy(() => import('./pages/pricing.js').then((module) => ({ default: module.PricingPage })));
const AccountPage = lazy(() => import('./pages/account.js').then((module) => ({ default: module.AccountPage })));
const UpgradePage = lazy(() => import('./pages/upgrade.js').then((module) => ({ default: module.UpgradePage })));
import { CataloguePage } from './pages/catalogue.js';
import { HistoryPage, SavedReviewPage } from './pages/history.js';
import { ReviewCatalogue, ReviewPage } from './pages/review.js';
import { LearnCatalogue, LearnPage } from './pages/learn.js';
import { SessionEntry } from './pages/session-entry.js';
import { useAuth } from './auth/provider.js';
import { usePath, navigate } from './navigation.js';
import { HomePage } from './pages/home.js';
import { BrandMark } from './components/brand-mark.js';
import { CurrentAttemptNotice } from './components/attempt-notice.js';
import { WorkingState } from './components/working-state.js';
export function App() {
  const path = usePath();
  const auth = useAuth();
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate('/');
          }}
          className="wordmark"
        >
          <BrandMark />
          OpsReplay
        </a>
        <nav className="actions" aria-label="Main navigation">
          <a
            className="site-navigation"
            href="/pricing"
            aria-current={path === '/pricing' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('/pricing');
            }}
          >
            Pricing
          </a>
          {auth.identity && (
            <a
              className="site-navigation"
              href="/account"
              aria-current={path === '/account' ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate('/account');
              }}
            >
              Account
            </a>
          )}
          <a
            className="site-navigation"
            href="/challenges"
            aria-current={path === '/challenges' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('/challenges');
            }}
          >
            Challenges
          </a>
          <a
            className="site-navigation"
            href="/learn"
            aria-current={path.startsWith('/learn') ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('/learn');
            }}
          >
            Learn
          </a>
          <a
            className="site-navigation"
            href="/reviews"
            aria-current={path.startsWith('/reviews') ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('/reviews');
            }}
          >
            Code Review
          </a>
          <a
            className="site-navigation"
            href="/history"
            aria-current={path === '/history' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('/history');
            }}
          >
            History
          </a>
          <Button
            variant="default"
            disabled={auth.loading}
            onClick={() => void (auth.identity ? auth.signOut() : auth.signIn())}
          >
            {auth.loading ? 'Connecting…' : auth.identity ? 'Sign out' : 'Sign in'}
          </Button>
          {!auth.loading && !auth.identity && <Button onClick={() => void auth.signUp()}>Create account</Button>}
        </nav>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className={
          ['/', '/challenges', '/pricing', '/upgrade', '/account'].includes(path)
            ? 'page catalogue-page'
            : 'page workspace-page'
        }
      >
        {auth.message && (
          <p role="alert" className="notice error">
            {auth.message}
          </p>
        )}
        {!path.startsWith('/sessions/') && path !== '/challenges' && path !== '/auth/callback' && (
          <CurrentAttemptNotice key={path + (auth.identity?.sub ?? 'public')} />
        )}
        {path === '/challenges' && (
          <>
            <h1>Challenges</h1>
            <p className="intro">
              Investigate a live failure in an isolated environment. Repair it, then review your evidence and response.
            </p>
          </>
        )}
        {path === '/' ? (
          <HomePage />
        ) : path === '/pricing' ? (
          <Suspense fallback={<WorkingState title="Opening access options" />}>
            <PricingPage />
          </Suspense>
        ) : path === '/account' ? (
          <Suspense fallback={<WorkingState title="Opening your account" />}>
            <AccountPage key={auth.identity?.sub ?? 'public'} />
          </Suspense>
        ) : path === '/upgrade' ? (
          <Suspense fallback={<WorkingState title="Opening demo checkout" />}>
            <UpgradePage key={auth.identity?.sub ?? 'public'} />
          </Suspense>
        ) : path === '/challenges' ? (
          <CataloguePage key={auth.identity?.sub ?? 'public'} />
        ) : path === '/history' ? (
          <HistoryPage key={auth.identity?.sub ?? 'public'} />
        ) : /^\/review-submissions\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
            path,
          ) ? (
          <SavedReviewPage key={path + (auth.identity?.sub ?? '')} id={path.split('/')[2]!} />
        ) : path === '/reviews' ? (
          <ReviewCatalogue />
        ) : /^\/reviews\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path) ? (
          <ReviewPage key={path + (auth.identity?.sub ?? '')} id={path.split('/')[2]!} />
        ) : path === '/learn' ? (
          <LearnCatalogue />
        ) : /^\/learn\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path) ? (
          <LearnPage key={path + (auth.identity?.sub ?? '')} id={path.split('/')[2]!} />
        ) : /^\/sessions\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?:\/debrief)?$/.test(
            path,
          ) ? (
          auth.loading ? (
            <WorkingState title="Connecting your account" />
          ) : auth.identity ? (
            path.endsWith('/debrief') ? (
              <Suspense fallback={<WorkingState title="Opening debrief" />}>
                <DebriefPage key={auth.identity.sub + path} id={path.split('/')[2]!} />
              </Suspense>
            ) : (
              <SessionEntry key={auth.identity.sub + path} id={path.split('/')[2]!} />
            )
          ) : (
            <section className="panel">
              <h2>Sign in to resume this attempt.</h2>
              <p>The incident clock continues while you are disconnected.</p>
              <Button onClick={() => void auth.signIn()}>Sign in</Button>
            </section>
          )
        ) : (
          <section className="panel">
            <h2>Page not found</h2>
            <a href="/challenges">Return to Challenges</a>
          </section>
        )}
        <footer className="site-footer">
          <span>OpsReplay · Learn production failures by investigating them.</span>
          <a href="/pricing">Access and pricing</a>
          <a
            href="/assets/font-licenses-51ccfb748053470fef44380455b1fb87aad161f6581a8997bb2bbed0dc37061b.txt"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Font licenses (opens in a new tab)"
          >
            Font licenses
          </a>
        </footer>
      </main>
    </>
  );
}
