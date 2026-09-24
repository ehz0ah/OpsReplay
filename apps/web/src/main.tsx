import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTheme, MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './styles.css';
import { App, AppBoundary } from './app.js';
import { RequestError } from './api/client.js';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15000,
      retry: (count, error) =>
        count < 1 &&
        (!(error instanceof RequestError) || error.status >= 500 || error.status === 0),
    },
  },
});
const theme = createTheme({
  fontFamily: 'IBM Plex Sans, sans-serif',
  fontFamilyMonospace: 'IBM Plex Mono, monospace',
  primaryColor: 'forest',
  primaryShade: 7,
  defaultRadius: 4,
  colors: {
    forest: [
      '#edf7f3',
      '#d9ece4',
      '#b0d5c7',
      '#84bca6',
      '#61a58c',
      '#468c74',
      '#33755f',
      '#245e4d',
      '#194d3f',
      '#103e33',
    ],
  },
  headings: { fontFamily: 'IBM Plex Sans, sans-serif', fontWeight: '500' },
  components: {
    Button: { defaultProps: { fw: 500 } },
    Modal: {
      defaultProps: {
        overlayProps: { backgroundOpacity: 0.3 },
        shadow: 'md',
        closeButtonProps: { 'aria-label': 'Close dialog' },
      },
    },
  },
});
const root = document.getElementById('root');
if (!root) throw new Error('Application mount point is missing.');
createRoot(root).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="light">
      <AppBoundary>
        <QueryClientProvider client={client}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AppBoundary>
    </MantineProvider>
  </StrictMode>,
);
