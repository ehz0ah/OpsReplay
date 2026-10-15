import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { useApi } from '../api-context.js';
import { TerminalAttachment, type AttachmentState } from './attachment.js';
export default function TerminalView({
  id,
  enabled = true,
  onFrame,
  onConnection,
  refresh,
}: {
  id: string;
  enabled?: boolean;
  onFrame?: (frame: PublicTypes['GatewayServerMessage']) => void;
  onConnection?: (connected: boolean) => void;
  refresh: () => void;
}) {
  const api = useApi(),
    host = useRef<HTMLDivElement>(null),
    emulator = useRef<Terminal | null>(null),
    attachment = useRef<TerminalAttachment | null>(null),
    screen = useRef(false);
  const activeInput = useRef(enabled);
  activeInput.current = enabled;
  const handlers = useRef({ onFrame, onConnection, refresh });
  handlers.current = { onFrame, onConnection, refresh };
  const [revision, setRevision] = useState(0),
    [state, setState] = useState<AttachmentState>('connecting'),
    [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      convertEol: false,
      disableStdin: true,
      theme: { background: '#101416', foreground: '#e6eceb' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    emulator.current = term;
    screen.current = false;
    const resize = () => {
      if (!host.current || host.current.clientWidth === 0 || host.current.clientHeight === 0) return;
      const dimensions = fit.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return;
      term.resize(Math.max(20, Math.min(500, dimensions.cols)), Math.max(5, Math.min(200, dimensions.rows)));
      attachment.current?.resize(term.cols, term.rows);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = term.onData((value) => {
      if (activeInput.current) attachment.current?.input(value);
    });
    const binary = term.onBinary((value) => {
      if (activeInput.current) attachment.current?.binary(value);
    });
    const visible = () => {
      if (document.visibilityState === 'visible') {
        resize();
        attachment.current?.heartbeat();
      }
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      observer.disconnect();
      input.dispose();
      binary.dispose();
      document.removeEventListener('visibilitychange', visible);
      attachment.current?.stop();
      emulator.current = null;
      term.dispose();
    };
  }, [id]);
  useEffect(() => {
    let disposed = false;
    const pending = new Set<() => void>();
    const term = emulator.current;
    if (!term) return;
    const connection = new TerminalAttachment(
      api,
      id,
      {
        state: (value, text) => {
          if (!disposed) {
            handlers.current.onConnection?.(value === 'ready');
            setState(value);
            setMessage(text);
            term.options.disableStdin = value !== 'ready' || !activeInput.current;
            if (value === 'ready') {
              screen.current = true;
              connection.resize(term.cols, term.rows);
            }
          }
        },
        output: (bytes) =>
          new Promise((resolve, reject) => {
            if (disposed) {
              resolve();
              return;
            }
            const finish = () => {
              clearTimeout(timer);
              pending.delete(finish);
              resolve();
            };
            const timer = setTimeout(() => {
              pending.delete(finish);
              reject(new Error('Terminal output timed out'));
            }, 5000);
            pending.add(finish);
            term.write(bytes, finish);
          }),
        frame: (value) => handlers.current.onFrame?.(value),
        refresh: () => handlers.current.refresh(),
      },
      undefined,
      ['localhost', '127.0.0.1'].includes(location.hostname),
      undefined,
      screen.current,
    );
    attachment.current = connection;
    void connection.start();
    return () => {
      disposed = true;
      handlers.current.onConnection?.(false);
      connection.stop();
      for (const finish of pending) finish();
      term.options.disableStdin = true;
    };
  }, [api, id, revision]);
  useEffect(() => {
    if (emulator.current) emulator.current.options.disableStdin = state !== 'ready' || !enabled;
  }, [state, enabled]);
  return (
    <section className="terminal-panel">
      <div className="terminal-heading">
        <h2>Terminal</h2>
        <span className="badge">{state}</span>
        {['replaced', 'closed', 'error'].includes(state) && (
          <button className="secondary" onClick={() => setRevision((value) => value + 1)}>
            {state === 'replaced' ? 'Take back terminal' : 'Reconnect'}
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <div ref={host} className="terminal-host" aria-label="Incident terminal" />
    </section>
  );
}
