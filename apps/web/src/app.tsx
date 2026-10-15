import { usePath, navigate } from './navigation.js';
export function App() {
  const path = usePath();
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
        <span className="status-label">Single-player workspace</span>
      </header>
      <main id="main" className="page">
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
