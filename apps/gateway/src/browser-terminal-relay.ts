import { Buffer } from 'node:buffer';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { TextDecoder } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';
import { TerminalAdmissionError, type TerminalAdmissionStore } from './terminal-admission-store.js';
import { TerminalClientError, type TerminalClientEnd } from './terminal-client.js';
import {
  GatewayTerminalSession,
  type OpenTerminalSessionOptions,
  type TerminalConnection,
  type TerminalSessionReady,
} from './terminal-session.js';

const DEFAULT_PATH = '/v1/terminal';
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_TIMEOUT_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MAX_BROWSER_INPUT_BYTES = 16 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 8 * 1024;
const MAX_PENDING_BROWSER_MESSAGES = 64;
const MAX_PENDING_BROWSER_BYTES = 64 * 1024;

type GatewayClientMessage =
  | { type: 'auth'; sessionId: string; ticket: string }
  | { type: 'heartbeat' }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'run_proposal'; proposalId: string };

type GatewayErrorCode =
  | 'AUTH_FAILED'
  | 'TICKET_EXPIRED'
  | 'SESSION_NOT_READY'
  | 'SESSION_TERMINAL'
  | 'REPLACED'
  | 'PROPOSAL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const errorMessages: Record<GatewayErrorCode, string> = {
  AUTH_FAILED: 'Terminal authentication failed.',
  TICKET_EXPIRED: 'The terminal ticket expired.',
  SESSION_NOT_READY: 'The terminal session is not ready.',
  SESSION_TERMINAL: 'The terminal session has ended.',
  REPLACED: 'This terminal connection was replaced.',
  PROPOSAL_UNAVAILABLE: 'Proposal execution is not available.',
  RATE_LIMITED: 'Terminal input is arriving too quickly.',
  INTERNAL_ERROR: 'The terminal connection failed.',
};

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
const compiledClientMessage = ajv
  .addSchema(publicSchema)
  .getSchema<GatewayClientMessage>(`${publicSchema.$id}#/$defs/GatewayClientMessage`);
if (compiledClientMessage === undefined) throw new Error('Gateway client message schema is unavailable.');
const validateClientMessage = compiledClientMessage;

const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface BrowserTerminalSession extends TerminalConnection {
  readonly sessionId: string;
  readonly generation: number;
}

export type BrowserTerminalSessionOpener = (
  options: OpenTerminalSessionOptions,
  signal?: AbortSignal,
) => Promise<{ session: BrowserTerminalSession; ready: TerminalSessionReady }>;

export interface GatewayBrowserPeer {
  isOpen(): boolean;
  send(data: string | Buffer, binary: boolean, callback: (error?: Error | null) => void): void;
  ping(callback: (error?: Error | null) => void): void;
  close(code: number, reason: string): void;
  terminate(): void;
  pause(): void;
  resume(): void;
  onMessage(listener: (data: Buffer, binary: boolean) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: () => void): () => void;
}

export interface GatewayBrowserTerminalConnectionOptions {
  openSession: BrowserTerminalSessionOpener;
  authTimeoutMs?: number;
  sendTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  initialColumns?: number;
  initialRows?: number;
  terminalPort?: number;
}

type ConnectionState = 'awaiting_auth' | 'authenticating' | 'ready' | 'closing' | 'closed';
type BrowserControlMessage = Exclude<GatewayClientMessage, { type: 'auth' }>;
type PendingBrowserMessage =
  | { kind: 'input'; chunks: Buffer[]; bytes: number }
  | { kind: 'control'; message: BrowserControlMessage; bytes: number }
  | { kind: 'keepalive'; bytes: 0 };

class BrowserSendError extends Error {
  constructor() {
    super('Browser terminal send failed.');
    this.name = 'BrowserSendError';
  }
}

function boundedMilliseconds(value: number | undefined, fallback: number, name: string, maximum = 60_000): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} is invalid.`);
  return result;
}

function boundedDimension(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`${name} is invalid.`);
  }
  return result;
}

function parseClientMessage(data: Buffer): GatewayClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(utf8.decode(data));
  } catch {
    return undefined;
  }
  if (!validateClientMessage(value)) return undefined;
  return value as GatewayClientMessage;
}

function publicError(code: GatewayErrorCode) {
  return { type: 'error' as const, code, message: errorMessages[code] };
}

function admissionErrorCode(error: TerminalAdmissionError): GatewayErrorCode {
  switch (error.code) {
    case 'auth_failed':
    case 'invalid_input':
      return 'AUTH_FAILED';
    case 'ticket_expired':
      return 'TICKET_EXPIRED';
    case 'session_not_ready':
      return 'SESSION_NOT_READY';
    case 'session_terminal':
      return 'SESSION_TERMINAL';
    case 'replaced':
      return 'REPLACED';
    default:
      return 'INTERNAL_ERROR';
  }
}

function terminalErrorCode(error: TerminalClientError): GatewayErrorCode {
  switch (error.code) {
    case 'replaced':
    case 'stale_generation':
      return 'REPLACED';
    case 'shell_exited':
      return 'SESSION_TERMINAL';
    default:
      return 'INTERNAL_ERROR';
  }
}

export class GatewayBrowserTerminalConnection {
  readonly closed: Promise<void>;

  private readonly authTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly initialColumns: number;
  private readonly initialRows: number;
  private readonly lifetime = new AbortController();
  private readonly pendingMessages: PendingBrowserMessage[] = [];
  private readonly unsubscribe: (() => void)[] = [];
  private readonly resolveClosed: () => void;
  private readonly outputGate: Promise<void>;
  private readonly releaseOutputGate: () => void;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private state: ConnectionState = 'awaiting_auth';
  private session: BrowserTerminalSession | undefined;
  private pendingBytes = 0;
  private processing = false;
  private outputPending = false;
  private sendTail: Promise<void> = Promise.resolve();
  private activeTasks = 0;
  private peerClosed = false;
  private authenticated = false;
  private heartbeatQueued = false;

  constructor(
    private readonly peer: GatewayBrowserPeer,
    private readonly options: GatewayBrowserTerminalConnectionOptions,
  ) {
    if (typeof options.openSession !== 'function') throw new TypeError('Terminal session opener is required.');
    this.authTimeoutMs = boundedMilliseconds(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS, 'Auth timeout');
    this.sendTimeoutMs = boundedMilliseconds(options.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS, 'Send timeout');
    this.heartbeatIntervalMs = boundedMilliseconds(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'Heartbeat interval',
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.initialColumns = boundedDimension(options.initialColumns, DEFAULT_COLUMNS, 20, 500, 'Initial columns');
    this.initialRows = boundedDimension(options.initialRows, DEFAULT_ROWS, 5, 200, 'Initial rows');
    if (
      options.terminalPort !== undefined &&
      (!Number.isSafeInteger(options.terminalPort) || options.terminalPort < 1 || options.terminalPort > 65_535)
    ) {
      throw new TypeError('Terminal port is invalid.');
    }
    let resolveClosed!: () => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.resolveClosed = resolveClosed;
    let releaseOutputGate!: () => void;
    this.outputGate = new Promise((resolve) => {
      releaseOutputGate = resolve;
    });
    this.releaseOutputGate = releaseOutputGate;

    this.unsubscribe.push(
      peer.onMessage((data, binary) => this.receive(data, binary)),
      peer.onClose(() => this.completeClose()),
      peer.onError(() => this.terminate()),
    );
    this.authTimer = setTimeout(() => this.fail('AUTH_FAILED', 1008), this.authTimeoutMs);
  }

  shutdown(): void {
    this.terminate();
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  private receive(data: Buffer, binary: boolean): void {
    if (this.state === 'awaiting_auth') {
      if (binary) {
        this.fail('AUTH_FAILED', 1008);
        return;
      }
      const message = parseClientMessage(data);
      if (message?.type !== 'auth') {
        this.fail('AUTH_FAILED', 1008);
        return;
      }
      this.state = 'authenticating';
      this.clearAuthTimer();
      this.startTask(this.authenticate(message));
      return;
    }
    if (this.state !== 'ready') {
      if (this.state === 'authenticating') this.closePolicyViolation();
      return;
    }

    if (binary) {
      if (data.length === 0 || data.length > MAX_BROWSER_INPUT_BYTES) {
        this.closePolicyViolation();
        return;
      }
      if (this.pendingBytes + data.length > MAX_PENDING_BROWSER_BYTES) {
        this.fail('RATE_LIMITED', 1008);
        return;
      }
      const tail = this.pendingMessages.at(-1);
      if (tail?.kind === 'input' && tail.bytes + data.length <= MAX_BROWSER_INPUT_BYTES) {
        tail.chunks.push(Buffer.from(data));
        tail.bytes += data.length;
      } else {
        if (this.pendingMessages.length >= MAX_PENDING_BROWSER_MESSAGES) {
          this.fail('RATE_LIMITED', 1008);
          return;
        }
        this.pendingMessages.push({ kind: 'input', chunks: [Buffer.from(data)], bytes: data.length });
      }
    } else {
      const parsed = parseClientMessage(data);
      if (parsed === undefined || parsed.type === 'auth') {
        this.closePolicyViolation();
        return;
      }
      if (
        this.pendingMessages.length >= MAX_PENDING_BROWSER_MESSAGES ||
        this.pendingBytes + data.length > MAX_PENDING_BROWSER_BYTES
      ) {
        this.fail('RATE_LIMITED', 1008);
        return;
      }
      this.pendingMessages.push({ kind: 'control', message: parsed, bytes: data.length });
    }
    this.pendingBytes += data.length;
    this.startProcessing();
  }

  private async authenticate(message: Extract<GatewayClientMessage, { type: 'auth' }>): Promise<void> {
    try {
      const opened = await this.options.openSession(
        {
          sessionId: message.sessionId,
          ticket: message.ticket,
          columns: this.initialColumns,
          rows: this.initialRows,
          onOutput: (data) => this.deliverOutput(data),
          ...(this.options.terminalPort === undefined ? {} : { terminalPort: this.options.terminalPort }),
        },
        this.lifetime.signal,
      );
      if (this.state !== 'authenticating') {
        opened.session.close();
        return;
      }
      this.session = opened.session;
      void this.watchTerminal(opened.session.ended);
      await this.sendJson({
        type: 'ready',
        sessionId: opened.ready.sessionId,
        status: 'ready',
        resumed: opened.ready.resumed,
        replayTruncated: opened.ready.replayTruncated,
      });
      if (this.state !== 'authenticating') return;
      this.state = 'ready';
      this.authenticated = true;
      this.releaseOutputGate();
      this.scheduleHeartbeat();
    } catch (error) {
      if (this.state !== 'authenticating') return;
      if (error instanceof TerminalAdmissionError) {
        const code = admissionErrorCode(error);
        this.fail(code, code === 'INTERNAL_ERROR' ? 1011 : 1008);
        return;
      }
      if (error instanceof TerminalClientError) {
        const code = terminalErrorCode(error);
        this.fail(code, code === 'INTERNAL_ERROR' ? 1011 : 1008);
        return;
      }
      this.fail('INTERNAL_ERROR', 1011);
    }
  }

  private async processMessages(): Promise<void> {
    this.processing = true;
    try {
      while (this.state === 'ready') {
        const pending = this.pendingMessages.shift();
        if (pending === undefined) break;
        try {
          await this.dispatch(pending);
        } catch (error) {
          this.handleOperationError(error);
        } finally {
          this.pendingBytes = Math.max(0, this.pendingBytes - pending.bytes);
        }
      }
    } finally {
      this.processing = false;
      if (this.state === 'ready') this.peer.resume();
    }
  }

  private async dispatch(pending: PendingBrowserMessage): Promise<void> {
    const session = this.session;
    if (session === undefined) throw new Error('Authenticated terminal session is missing.');
    if (pending.kind === 'input') {
      const data = pending.chunks.length === 1 ? pending.chunks[0] : Buffer.concat(pending.chunks, pending.bytes);
      if (data === undefined) throw new Error('Queued terminal input is missing.');
      await session.input(data, this.lifetime.signal);
      this.scheduleHeartbeat();
      return;
    }
    if (pending.kind === 'keepalive') {
      this.heartbeatQueued = false;
      await session.heartbeat(this.lifetime.signal);
      await this.ping();
      this.scheduleHeartbeat();
      return;
    }
    const message = pending.message;
    switch (message.type) {
      case 'heartbeat':
        return;
      case 'resize':
        await session.resize(message.cols, message.rows, this.lifetime.signal);
        this.scheduleHeartbeat();
        return;
      case 'run_proposal':
        await this.sendJson(publicError('PROPOSAL_UNAVAILABLE'));
    }
  }

  private handleOperationError(error: unknown): void {
    if (this.state !== 'ready') return;
    if (error instanceof TerminalAdmissionError) {
      const code = admissionErrorCode(error);
      this.fail(code, code === 'INTERNAL_ERROR' ? 1011 : 1008);
      return;
    }
    if (error instanceof TerminalClientError) {
      const code = terminalErrorCode(error);
      this.fail(code, code === 'INTERNAL_ERROR' ? 1011 : 1008);
      return;
    }
    this.fail('INTERNAL_ERROR', 1011);
  }

  private async deliverOutput(data: Buffer): Promise<void> {
    await this.outputGate;
    if (this.state !== 'ready' || data.length === 0 || data.length > MAX_TERMINAL_OUTPUT_BYTES) {
      this.terminate();
      throw new BrowserSendError();
    }
    if (this.outputPending) {
      this.terminate();
      throw new BrowserSendError();
    }
    this.outputPending = true;
    try {
      await this.send(data, true);
    } catch {
      this.terminate();
      throw new BrowserSendError();
    } finally {
      this.outputPending = false;
    }
  }

  private async watchTerminal(ended: Promise<TerminalClientEnd>): Promise<void> {
    const result = await ended;
    if (this.state !== 'authenticating' && this.state !== 'ready') return;
    if (result.reason === 'exit') {
      this.fail('SESSION_TERMINAL', 1008);
      return;
    }
    if (result.reason === 'error') {
      const code = terminalErrorCode(result.error);
      this.fail(code, code === 'INTERNAL_ERROR' ? 1011 : 1008);
      return;
    }
    this.fail('INTERNAL_ERROR', 1011);
  }

  private sendJson(value: object): Promise<void> {
    return this.send(JSON.stringify(value), false);
  }

  private send(data: string | Buffer, binary: boolean): Promise<void> {
    return this.queueSend((finish) => this.peer.send(data, binary, finish));
  }

  private ping(): Promise<void> {
    return this.queueSend((finish) => this.peer.ping(finish));
  }

  private queueSend(start: (finish: (error?: Error | null) => void) => void): Promise<void> {
    const operation = this.sendTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!this.peer.isOpen()) {
            reject(new BrowserSendError());
            return;
          }
          let settled = false;
          const timeout = setTimeout(() => finish(new BrowserSendError()), this.sendTimeoutMs);
          const finish = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error == null) resolve();
            else reject(new BrowserSendError());
          };
          try {
            start(finish);
          } catch (error) {
            finish(error instanceof Error ? error : new BrowserSendError());
          }
        }),
    );
    this.sendTail = operation.catch(() => undefined);
    return operation;
  }

  private startProcessing(): void {
    if (this.processing) return;
    this.peer.pause();
    this.startTask(this.processMessages());
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeatTimer();
    if (this.state !== 'ready' || this.heartbeatQueued) return;
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (this.state !== 'ready' || this.heartbeatQueued) return;
      this.heartbeatQueued = true;
      this.pendingMessages.push({ kind: 'keepalive', bytes: 0 });
      this.startProcessing();
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private fail(code: GatewayErrorCode, closeCode: number): void {
    if (!this.beginClose()) return;
    void this.sendJson(publicError(code)).then(
      () => this.closePeer(closeCode, code),
      () => this.terminatePeer(),
    );
  }

  private closePolicyViolation(): void {
    if (!this.beginClose()) return;
    this.closePeer(1008, 'Invalid terminal message');
  }

  private beginClose(): boolean {
    if (this.state === 'closing' || this.state === 'closed') return false;
    this.state = 'closing';
    this.clearAuthTimer();
    this.clearHeartbeatTimer();
    this.lifetime.abort(new Error('Browser terminal connection closed.'));
    this.session?.close();
    this.releaseOutputGate();
    this.pendingMessages.length = 0;
    this.pendingBytes = 0;
    this.heartbeatQueued = false;
    try {
      this.peer.resume();
    } catch {
      /* The peer can already be closed. */
    }
    return true;
  }

  private closePeer(code: number, reason: string): void {
    if (!this.peer.isOpen()) {
      this.completeClose();
      return;
    }
    this.closeTimer = setTimeout(() => this.terminatePeer(), this.sendTimeoutMs);
    try {
      this.peer.close(code, reason);
    } catch {
      this.terminatePeer();
    }
  }

  private terminate(): void {
    this.beginClose();
    this.terminatePeer();
  }

  private terminatePeer(): void {
    try {
      this.peer.terminate();
    } catch {
      /* Socket cleanup must finish even if the transport is already broken. */
    } finally {
      this.completeClose();
    }
  }

  private completeClose(): void {
    if (!this.peerClosed) {
      this.beginClose();
      this.state = 'closed';
      this.peerClosed = true;
      if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
      for (const remove of this.unsubscribe.splice(0)) remove();
    }
    this.resolveWhenSettled();
  }

  private startTask(task: Promise<void>): void {
    this.activeTasks++;
    void task.then(
      () => this.finishTask(),
      () => {
        this.terminate();
        this.finishTask();
      },
    );
  }

  private finishTask(): void {
    this.activeTasks--;
    this.resolveWhenSettled();
  }

  private resolveWhenSettled(): void {
    if (this.peerClosed && this.activeTasks === 0) this.resolveClosed();
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== undefined) clearTimeout(this.authTimer);
    this.authTimer = undefined;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

export interface GatewayBrowserTerminalRelayOptions {
  allowedOrigins: readonly string[];
  admissions: TerminalAdmissionStore;
  maxConnections: number;
  maxPendingAuthentications: number;
  path?: string;
  authTimeoutMs?: number;
  sendTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  initialColumns?: number;
  initialRows?: number;
  terminalPort?: number;
}

export interface GatewayBrowserTerminalRelayDependencies {
  openSession?: BrowserTerminalSessionOpener;
}

function canonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Allowed terminal origin is invalid.');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('Allowed terminal origin is invalid.');
  }
  return parsed.origin;
}

function requestOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function requestPath(request: IncomingMessage): string | undefined {
  if (request.method !== 'GET' || request.url === undefined) return undefined;
  try {
    const parsed = new URL(request.url, 'http://gateway.invalid');
    return parsed.search === '' && parsed.hash === '' ? parsed.pathname : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} is invalid.`);
  return value;
}

function rejectUpgrade(socket: Duplex, status: 400 | 403 | 404 | 503): void {
  const reason =
    status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : status === 503
          ? 'Service Unavailable'
          : 'Bad Request';
  if (socket.writable) {
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } else {
    socket.destroy();
  }
}

function rawData(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function adaptWebSocket(socket: WebSocket): GatewayBrowserPeer {
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data, binary, callback) => socket.send(data, { binary, compress: false }, callback),
    ping: (callback) => socket.ping(undefined, false, callback),
    close: (code, reason) => socket.close(code, reason),
    terminate: () => socket.terminate(),
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    onMessage: (listener) => {
      const wrapped = (data: RawData, binary: boolean) => listener(rawData(data), binary);
      socket.on('message', wrapped);
      return () => socket.off('message', wrapped);
    },
    onClose: (listener) => {
      socket.on('close', listener);
      return () => socket.off('close', listener);
    },
    onError: (listener) => {
      socket.on('error', listener);
      return () => socket.off('error', listener);
    },
  };
}

export class GatewayBrowserTerminalRelay {
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_BROWSER_INPUT_BYTES,
  });
  private readonly origins: ReadonlySet<string>;
  private readonly path: string;
  private readonly connections = new Set<GatewayBrowserTerminalConnection>();
  private readonly openSession: BrowserTerminalSessionOpener;
  private readonly maxConnections: number;
  private readonly maxPendingAuthentications: number;
  private readonly onUpgrade: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly server: HttpServer,
    private readonly options: GatewayBrowserTerminalRelayOptions,
    dependencies: GatewayBrowserTerminalRelayDependencies = {},
  ) {
    if (options.allowedOrigins.length === 0) throw new TypeError('At least one terminal origin is required.');
    this.origins = new Set(options.allowedOrigins.map(canonicalOrigin));
    this.path = options.path ?? DEFAULT_PATH;
    if (!this.path.startsWith('/') || this.path.includes('?') || this.path.includes('#')) {
      throw new TypeError('Terminal WebSocket path is invalid.');
    }
    this.maxConnections = positiveInteger(options.maxConnections, 'Maximum terminal connections');
    this.maxPendingAuthentications = positiveInteger(
      options.maxPendingAuthentications,
      'Maximum pending terminal authentications',
    );
    if (this.maxPendingAuthentications > this.maxConnections) {
      throw new TypeError('Maximum pending terminal authentications cannot exceed maximum terminal connections.');
    }
    this.openSession =
      dependencies.openSession ??
      ((sessionOptions, signal) =>
        GatewayTerminalSession.open(sessionOptions, { admissions: options.admissions }, signal));
    this.onUpgrade = (request, socket, head) => this.upgrade(request, socket, head);
    server.on('upgrade', this.onUpgrade);
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.server.off('upgrade', this.onUpgrade);
    for (const connection of this.connections) connection.shutdown();
    await Promise.all([...this.connections].map((connection) => connection.closed));
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    if (requestPath(request) !== this.path) {
      rejectUpgrade(socket, 404);
      return;
    }
    const origin = requestOrigin(request.headers.origin);
    if (origin === undefined || !this.origins.has(origin)) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (
      this.connections.size >= this.maxConnections ||
      [...this.connections].filter((connection) => !connection.isAuthenticated()).length >=
        this.maxPendingAuthentications
    ) {
      rejectUpgrade(socket, 503);
      return;
    }
    try {
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => this.accept(webSocket));
    } catch {
      rejectUpgrade(socket, 400);
    }
  }

  private accept(socket: WebSocket): void {
    const connection = new GatewayBrowserTerminalConnection(adaptWebSocket(socket), {
      openSession: this.openSession,
      ...(this.options.authTimeoutMs === undefined ? {} : { authTimeoutMs: this.options.authTimeoutMs }),
      ...(this.options.sendTimeoutMs === undefined ? {} : { sendTimeoutMs: this.options.sendTimeoutMs }),
      ...(this.options.heartbeatIntervalMs === undefined
        ? {}
        : { heartbeatIntervalMs: this.options.heartbeatIntervalMs }),
      ...(this.options.initialColumns === undefined ? {} : { initialColumns: this.options.initialColumns }),
      ...(this.options.initialRows === undefined ? {} : { initialRows: this.options.initialRows }),
      ...(this.options.terminalPort === undefined ? {} : { terminalPort: this.options.terminalPort }),
    });
    this.connections.add(connection);
    void connection.closed.then(() => this.connections.delete(connection));
  }
}
