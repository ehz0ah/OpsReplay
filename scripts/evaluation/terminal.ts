import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

/** Harmless probe only. Never forwards a provider command or arbitrary input. */
export function terminalProbe(
  urlText: string,
  origin: string,
  sessionId: string,
  ticket: string,
  signal: AbortSignal,
  createSocket = (url: URL, options: WebSocket.ClientOptions) => new WebSocket(url, options),
) {
  const url = new URL(urlText);
  if (
    url.protocol !== 'wss:' ||
    url.pathname !== '/v1/terminal' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid terminal endpoint.');
  return new Promise<{ admissionMs: number; roundTripMs: number }>((resolve, reject) => {
    const openedAt = performance.now(),
      marker = 'opsreplay_eval_' + randomUUID().replaceAll('-', '');
    const socket = createSocket(url, { origin, maxPayload: 16384, handshakeTimeout: 10000 });
    let sentAt: number | null = null,
      admissionMs = 0,
      output = '',
      finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      socket.terminate();
      if (error) reject(error);
      else resolve({ admissionMs, roundTripMs: performance.now() - sentAt! });
    };
    const abort = () => finish(new Error('terminal_timeout'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    socket.once('open', () => socket.send(JSON.stringify({ type: 'auth', sessionId, ticket })));
    socket.on('message', (data, binary) => {
      if (finished) return;
      try {
        if (!binary) {
          const frame = JSON.parse(data.toString());
          if (frame.type === 'error' && frame.code !== 'TELEMETRY_UNAVAILABLE') {
            finish(new Error('terminal_rejected'));
            return;
          }
          if (frame.type === 'ready') {
            if (frame.sessionId !== sessionId || frame.status !== 'ready' || sentAt !== null)
              throw new Error('Invalid readiness.');
            admissionMs = performance.now() - openedAt;
            sentAt = performance.now();
            // Abort any test-only partial line, then print a unique value.
            // Octal escapes stop terminal input echo from satisfying the output probe.
            const escaped = [...marker].map((c) => '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')).join('');
            socket.send(Buffer.from(`\x03printf '${escaped}\\n'\n`));
          }
          if (frame.type === 'status' && frame.status !== 'ready') finish(new Error('session_ended'));
          return;
        }
        if (sentAt === null) throw new Error('Output before admission.');
        output = (output + data.toString()).slice(-8192);
        if (output.includes(marker)) finish();
      } catch {
        finish(new Error('terminal_protocol'));
      }
    });
    socket.once('error', () => finish(new Error('terminal_transport')));
    socket.once('close', () => finish(new Error('terminal_closed')));
  });
}
