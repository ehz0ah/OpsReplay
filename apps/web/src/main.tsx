import '@mantine/core/styles/baseline.css';
import '@mantine/core/styles/default-css-variables.css';
import '@mantine/core/styles/global.css';
import '@mantine/core/styles/UnstyledButton.css';
import '@mantine/core/styles/Loader.css';
import '@mantine/core/styles/Button.css';
import '@mantine/core/styles/Alert.css';
import '@mantine/core/styles/Badge.css';
import '@mantine/core/styles/Group.css';
import '@mantine/core/styles/Overlay.css';
import '@mantine/core/styles/Paper.css';
import '@mantine/core/styles/ModalBase.css';
import '@mantine/core/styles/Modal.css';
import '@mantine/core/styles/CloseButton.css';
import '@mantine/core/styles/Progress.css';
import '@mantine/core/styles/Tabs.css';
import '@mantine/core/styles/Input.css';
import '@mantine/core/styles/Popover.css';
import '@mantine/core/styles/Combobox.css';
import '@mantine/core/styles/ScrollArea.css';
import '@mantine/core/styles/InlineInput.css';
import '@mantine/core/styles/Switch.css';
import { MantineProvider } from '@mantine/core';
import { theme } from './theme.js';
import { Button } from '@mantine/core';
import { ApiProvider } from './api-context.js';
import { AuthProvider } from './auth/provider.js';
import { ConfigContext } from './config-context.js';
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { loadConfig } from './config.js';
import { WorkingState } from './components/working-state.js';
import './styles.css';
import './fonts.css';
import './neobrutalist.css';
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
        <Button onClick={() => location.reload()}>Reload</Button>
      </main>
    ) : (
      this.props.children
    );
  }
}
const container = document.getElementById('root');
if (!container) throw new Error('Application root is missing.');
const root = createRoot(container);
root.render(
  <MantineProvider theme={theme} forceColorScheme="light">
    <main className="page">
      <WorkingState title="Opening OpsReplay">Loading the application configuration.</WorkingState>
    </main>
  </MantineProvider>,
);
loadConfig()
  .then((config) =>
    root.render(
      <MantineProvider theme={theme} forceColorScheme="light">
        <Boundary>
          <ConfigContext value={config}>
            <AuthProvider>
              <ApiProvider>
                <App />
              </ApiProvider>
            </AuthProvider>
          </ConfigContext>
        </Boundary>
      </MantineProvider>,
    ),
  )
  .catch(() =>
    root.render(
      <MantineProvider theme={theme} forceColorScheme="light">
        <main className="page">
          <h1>The workspace is unavailable.</h1>
          <p>Application configuration could not be loaded. Try again.</p>
          <Button onClick={() => location.reload()}>Reload</Button>
        </main>
      </MantineProvider>,
    ),
  );
