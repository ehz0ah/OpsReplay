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
        <p className="eyebrow">Production engineering / Practice</p>
        <h1>
          Learn production failures
          <br />
          by investigating them.
        </h1>
        <p className="intro">Read the signals. Test your hypothesis. Restore service, then review the evidence.</p>
        {path === '/' ? (
          <section className="panel">
            <h2>Your practice workspace</h2>
            <p>Start with an alert. Investigate an isolated system, restore service, then review your response.</p>
          </section>
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
