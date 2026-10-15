import { lazy, Suspense } from 'react';
const DebriefPage = lazy(() => import('./pages/debrief.js').then((module) => ({ default: module.DebriefPage })));
import { CataloguePage } from './pages/catalogue.js';
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
          <span className="status-label">Single-player workspace</span>
          <button
            className="secondary"
            disabled={auth.loading}
            onClick={() => void (auth.identity ? auth.signOut() : auth.signIn())}
          >
            {auth.loading ? 'Connecting…' : auth.identity ? 'Sign out' : 'Sign in'}
          </button>
        </div>
      </header>
      <main id="main" className="page">
        {auth.message && (
          <p role="alert" className="notice error">
            {auth.message}
          </p>
        )}
        {path === '/' && (
          <>
            {' '}
            <p className="eyebrow">Production engineering / Practice</p>
            <h1>
              Learn production failures
              <br />
              by investigating them.
            </h1>
            <p className="intro">Read the signals. Test your hypothesis. Restore service, then review the evidence.</p>
          </>
        )}
        {path === '/' ? (
          <CataloguePage key={auth.identity?.sub ?? 'public'} />
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
              <button onClick={() => void auth.signIn()}>Sign in</button>
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
