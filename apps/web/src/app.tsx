import { Button } from '@mantine/core';
import { lazy, Suspense } from 'react';
const DebriefPage = lazy(() => import('./pages/debrief.js').then((module) => ({ default: module.DebriefPage })));
import { CataloguePage } from './pages/catalogue.js';
import { ReviewCatalogue, ReviewPage } from './pages/review.js';
import { LearnCatalogue, LearnPage } from './pages/learn.js';
import { SessionEntry } from './pages/session-entry.js';
import { useAuth } from './auth/provider.js';
import { usePath, navigate } from './navigation.js';
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
          OpsReplay<span>Incident practice</span>
        </a>
        <div className="actions">
          <a
            className="site-navigation"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate('/');
            }}
          >
            Challenges
          </a>
          <a
            className="site-navigation"
            href="/learn"
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
            onClick={(event) => {
              event.preventDefault();
              navigate('/reviews');
            }}
          >
            Code Review
          </a>
          <Button
            variant="default"
            disabled={auth.loading}
            onClick={() => void (auth.identity ? auth.signOut() : auth.signIn())}
          >
            {auth.loading ? 'Connecting…' : auth.identity ? 'Sign out' : 'Sign in'}
          </Button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={path === '/' ? 'page catalogue-page' : 'page workspace-page'}>
        {auth.message && (
          <p role="alert" className="notice error">
            {auth.message}
          </p>
        )}
        {path === '/' && (
          <>
            <p className="eyebrow">Production engineering</p>
            <h1>Practice incident response.</h1>
            <p className="intro">
              Investigate a live failure in an isolated environment. Repair it, then review your evidence and response.
            </p>
          </>
        )}
        {path === '/' ? (
          <CataloguePage key={auth.identity?.sub ?? 'public'} />
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
            <p role="status">Connecting your account…</p>
          ) : auth.identity ? (
            path.endsWith('/debrief') ? (
              <Suspense fallback={<p>Opening debrief…</p>}>
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
            <a href="/">Return to Challenges</a>
          </section>
        )}
        <footer>OpsReplay · NUS CS5224</footer>
      </main>
    </>
  );
}
