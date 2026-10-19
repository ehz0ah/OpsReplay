import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { parsePublic } from '../../../../packages/contracts/public-validation.js';
import { ApiClient, ApiError, TransportError } from '../api.js';
import { pause, retryDelay } from '../lifecycle.js';
export type AttachmentState = 'connecting' | 'ready' | 'reconnecting' | 'replaced' | 'closed' | 'error';
export interface TerminalSocket {
  binaryType: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send(value: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number): void;
}
export interface AttachmentCallbacks {
  state: (state: AttachmentState, message: string | null) => void;
  output: (bytes: Uint8Array) => Promise<void>;
  frame: (frame: PublicTypes['GatewayServerMessage']) => void;
  refresh: () => void;
}
export function terminalUrl(value: string, local: boolean) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/terminal' ||
    !(url.protocol === 'wss:' || (local && url.protocol === 'ws:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    throw new Error('Invalid terminal endpoint.');
  return url.href;
}
export class TerminalAttachment {
  private readonly lifetime = new AbortController();
  private socket: TerminalSocket | null = null;
  private writable = false;
  private hasScreen: boolean;
  private current: AttachmentState = 'connecting';
  constructor(
    private readonly api: ApiClient,
    private readonly id: string,
    private readonly callbacks: AttachmentCallbacks,
    private readonly createSocket: (url: string) => TerminalSocket = (url) => new WebSocket(url),
    private readonly local = false,
    private readonly wait: (ms: number, signal: AbortSignal) => Promise<void> = pause,
    hasScreen = false,
  ) {
    this.hasScreen = hasScreen;
  }
  private state(value: AttachmentState, message: string | null = null) {
    this.current = value;
    if (!this.lifetime.signal.aborted) this.callbacks.state(value, message);
  }
  async start() {
    let attempts = 0;
    let interrupted = false;
    while (!this.lifetime.signal.aborted) {
      this.state(
        interrupted ? 'reconnecting' : 'connecting',
        interrupted ? 'Connection interrupted. The incident clock is still running.' : null,
      );
      let failure: unknown;
      try {
        const ticket = await this.api.mutate(
          'TerminalTicket',
          `/v1/sessions/${this.id}/terminal-tickets`,
          undefined,
          this.lifetime.signal,
        );
        if (this.lifetime.signal.aborted) return;
        if (ticket.sessionId !== this.id) throw new Error('Terminal ticket belongs to another attempt.');
        terminalUrl(ticket.url, this.local);
        const result = await this.attach(ticket);
        if (!result.retry || this.lifetime.signal.aborted) return;
        if (result.ready) attempts = 0;
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        if (
          error instanceof ApiError &&
          ([401, 403, 404].includes(error.status) || error.detail.code === 'SESSION_TERMINAL')
        ) {
          this.state('closed', 'The terminal cannot be opened. Read current session state or sign in again.');
          this.callbacks.refresh();
          return;
        }
        if (
          !(error instanceof TransportError) &&
          !(
            error instanceof ApiError &&
            (error.status === 429 || error.status >= 500 || error.detail.code === 'SESSION_NOT_READY')
          )
        ) {
          this.state(
            'error',
            'The terminal could not be opened safely. Read current session state before reconnecting.',
          );
          return;
        }
        failure = error;
      }
      interrupted = true;
      try {
        await this.wait(retryDelay(failure, ++attempts), this.lifetime.signal);
      } catch {
        return;
      }
    }
  }
  private attach(ticket: PublicTypes['TerminalTicket']): Promise<{ retry: boolean; ready: boolean }> {
    return new Promise((resolve, reject) => {
      let socket: TerminalSocket;
      try {
        socket = this.createSocket(terminalUrl(ticket.url, this.local));
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      this.writable = false;
      let ready = false;
      let done = false,
        queuedBytes = 0,
        queuedFrames = 0;
      let queue = Promise.resolve();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const watchdog = setTimeout(() => finish(true), 15000);
      const abort = () => finish(false);
      const finish = (retry: boolean) => {
        if (done) return;
        done = true;
        this.writable = false;
        clearTimeout(watchdog);
        if (heartbeat) clearInterval(heartbeat);
        this.lifetime.signal.removeEventListener('abort', abort);
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        if (this.socket === socket) this.socket = null;
        try {
          socket.close(1000);
        } catch {
          /* A closed transport needs no further action. */
        }
        resolve({ retry, ready });
      };
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      socket.onopen = () => {
        if (done || this.lifetime.signal.aborted) {
          finish(false);
          return;
        }
        try {
          socket.send(JSON.stringify({ type: 'auth', sessionId: this.id, ticket: ticket.ticket }));
        } catch {
          finish(true);
        }
      };
      socket.onclose = (event) => {
        void queue.finally(() => {
          if (done) return;
          if (event.code === 1008) {
            this.state('closed', 'Terminal access stopped. Read current state before opening it again.');
            this.callbacks.refresh();
            finish(false);
          } else finish(this.current !== 'replaced' && this.current !== 'closed' && this.current !== 'error');
        });
      };
      socket.onerror = () => finish(true);
      socket.onmessage = (event) => {
        const value: unknown = event.data;
        const size =
          typeof value === 'string'
            ? new TextEncoder().encode(value).length
            : value instanceof ArrayBuffer
              ? value.byteLength
              : Infinity;
        if (size > 16384 || queuedFrames >= 512 || queuedBytes + size > 2 * 1024 * 1024) {
          this.state('error', 'Terminal output exceeded the browser buffer. Reconnect to inspect the shell.');
          finish(false);
          return;
        }
        queuedBytes += size;
        queuedFrames++;
        queue = queue
          .then(async () => {
            if (done || this.lifetime.signal.aborted) return;
            if (value instanceof ArrayBuffer) {
              if (!this.writable) throw new Error('Output arrived before terminal admission.');
              await this.callbacks.output(new Uint8Array(value));
              return;
            }
            const frame = await parsePublic('GatewayServerMessage', JSON.parse(value as string));
            if (done || this.lifetime.signal.aborted) return;
            if (frame.type === 'ready') {
              if (frame.sessionId !== this.id || frame.status !== 'ready' || this.writable)
                throw new Error('Invalid terminal readiness.');
              ready = true;
              this.writable = true;
              clearTimeout(watchdog);
              const warning = frame.replayTruncated
                ? 'Output continuity is incomplete. Inspect the shell before acting.'
                : frame.resumed && !this.hasScreen
                  ? 'Existing shell resumed. Earlier screen contents are not available in this view.'
                  : null;
              this.hasScreen = true;
              this.state('ready', warning);
              heartbeat = setInterval(() => this.heartbeat(), 15000);
            } else if (frame.type === 'status' && frame.status !== 'ready') {
              this.state('closed', 'The attempt has ended.');
              this.callbacks.refresh();
              finish(false);
            } else if (frame.type === 'error') {
              if (frame.code === 'REPLACED') {
                this.state(
                  'replaced',
                  'This attempt was opened elsewhere. Take it back only when you want to control it here.',
                );
                finish(false);
              } else if (frame.code === 'SESSION_TERMINAL') {
                this.state('closed', 'The attempt has ended.');
                this.callbacks.refresh();
                finish(false);
              } else if (frame.code === 'TICKET_EXPIRED' || frame.code === 'SESSION_NOT_READY') {
                this.callbacks.refresh();
                finish(true);
              } else if (!['TELEMETRY_UNAVAILABLE', 'TERMINAL_BUSY', 'PROPOSAL_UNAVAILABLE'].includes(frame.code)) {
                this.state(
                  'error',
                  frame.code === 'RATE_LIMITED'
                    ? 'Input delivery is uncertain. Inspect the shell before sending more input.'
                    : frame.message,
                );
                this.callbacks.refresh();
                finish(false);
              }
            }
            this.callbacks.frame(frame);
          })
          .catch(() => {
            if (done || this.lifetime.signal.aborted) return;
            this.state('error', 'The terminal protocol could not be read safely.');
            finish(false);
          })
          .finally(() => {
            queuedBytes -= size;
            queuedFrames--;
          });
      };
    });
  }
  input(value: string): boolean {
    return this.sendInput(new TextEncoder().encode(value));
  }
  binary(value: string): boolean {
    return this.sendInput(Uint8Array.from(value, (character) => character.charCodeAt(0) & 255));
  }
  private sendInput(bytes: Uint8Array<ArrayBuffer>): boolean {
    if (!this.writable || this.lifetime.signal.aborted || this.socket?.readyState !== 1) return false;
    if (!bytes.length) return true;
    if (bytes.length > 65536 || this.socket.bufferedAmount + bytes.length > 65536) {
      this.callbacks.state('ready', 'Input was not sent. Paste a smaller block after the connection catches up.');
      return false;
    }
    try {
      for (let offset = 0; offset < bytes.length; offset += 4096)
        this.socket.send(bytes.subarray(offset, offset + 4096));
      return true;
    } catch {
      this.writable = false;
      this.state(
        'reconnecting',
        'Input delivery is uncertain. It will not be resent. Inspect the shell after reconnect.',
      );
      this.socket.close();
      return false;
    }
  }
  resize(cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    this.control({
      type: 'resize',
      cols: Math.max(20, Math.min(500, Math.floor(cols))),
      rows: Math.max(5, Math.min(200, Math.floor(rows))),
    });
  }
  confirmProposal(id: string, queryOnly = false): boolean {
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !this.writable ||
      this.socket?.readyState !== 1 ||
      this.socket.bufferedAmount > 65536
    )
      return false;
    try {
      this.socket.send(JSON.stringify({ type: queryOnly ? 'query_proposal' : 'run_proposal', proposalId: id }));
      return true;
    } catch {
      this.writable = false;
      this.socket.close();
      return false;
    }
  }
  heartbeat() {
    this.control({ type: 'heartbeat' });
  }
  private control(value: PublicTypes['GatewayClientMessage']) {
    if (!this.writable || this.socket?.readyState !== 1 || this.socket.bufferedAmount > 65536) return;
    try {
      this.socket.send(JSON.stringify(value));
    } catch {
      this.writable = false;
      this.socket.close();
    }
  }
  stop() {
    this.writable = false;
    this.lifetime.abort();
  }
}
