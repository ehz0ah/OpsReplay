import { ApiProvider } from './api-context.js';
import { AuthProvider } from './auth/provider.js';
import { ConfigContext } from './config-context.js';
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { loadConfig } from './config.js';
import './styles.css';
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="page">
        <h1>The workspace could not open.</h1>
        <p>Reload to read the saved session state.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const container = document.getElementById('root');
if (!container) throw new Error('Application root is missing.');
const root = createRoot(container);
loadConfig()
  .then((config) =>
    root.render(
      <Boundary>
        <ConfigContext value={config}>
          <AuthProvider>
            <ApiProvider>
              <App />
            </ApiProvider>
          </AuthProvider>
        </ConfigContext>
      </Boundary>,
    ),
  )
  .catch(() =>
    root.render(
      <main className="page">
        <h1>The workspace is unavailable.</h1>
        <p>Application configuration could not be loaded. Try again.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </main>,
    ),
  );
