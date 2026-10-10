import { Buffer } from 'node:buffer';
import { isIP, Socket } from 'node:net';

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 7681;
const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 24 * 1024;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_GENERATION = 2 ** 53 - 1;
const MAX_TERMINAL_DIMENSION = 500;

export type TerminalClientErrorCode =
  | 'cancelled'
  | 'closed'
  | 'connect_timeout'
  | 'input_uncertain'
  | 'invalid_response'
  | 'operation_timeout'
  | 'output_failed'
  | 'replaced'
  | 'server_rejected'
  | 'shell_exited'
  | 'stale_generation'
  | 'transport_failed';

const errorMessages: Record<TerminalClientErrorCode, string> = {
  cancelled: 'Terminal operation was cancelled.',
  closed: 'Terminal client is closed.',
  connect_timeout: 'Terminal connection timed out.',
  input_uncertain: 'Terminal input might have been accepted.',
  invalid_response: 'Terminal server returned an invalid response.',
  operation_timeout: 'Terminal operation timed out.',
  output_failed: 'Terminal output consumer failed.',
  replaced: 'Terminal connection was replaced.',
  server_rejected: 'Terminal server rejected the request.',
  shell_exited: 'Terminal shell exited.',
  stale_generation: 'Terminal input generation is stale.',
  transport_failed: 'Terminal transport failed.',
};

export type TerminalServerErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'IDLE_TIMEOUT'
  | 'INPUT_UNCERTAIN'
  | 'INVALID_FRAME'
  | 'REPLACED'
  | 'SHELL_EXITED'
  | 'STALE_GENERATION';

const terminalServerErrors = new Set<TerminalServerErrorCode>([
  'FRAME_TOO_LARGE',
  'IDLE_TIMEOUT',
  'INPUT_UNCERTAIN',
  'INVALID_FRAME',
  'REPLACED',
  'SHELL_EXITED',
  'STALE_GENERATION',
]);

export class TerminalClientError extends Error {
  readonly code: TerminalClientErrorCode;
  readonly serverCode: TerminalServerErrorCode | undefined;

  constructor(code: TerminalClientErrorCode, options?: { cause?: unknown; serverCode?: TerminalServerErrorCode }) {
    super(errorMessages[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TerminalClientError';
    this.code = code;
    this.serverCode = options?.serverCode;
  }
}

export interface TerminalReady {
  resumed: boolean;
  replayTruncated: boolean;
}

export type TerminalClientEnd =
  { reason: 'closed' } | { reason: 'error'; error: TerminalClientError } | { reason: 'exit'; code: number };

export interface TerminalClientOptions {
  host: string;
  port?: number;
  generation: number;
  columns: number;
  rows: number;
  onOutput: (data: Buffer) => void | Promise<void>;
  connectTimeoutMs?: number;
  operationTimeoutMs?: number;
}

type ReadyFrame = {
  type: 'ready';
  version: number;
  generation: number;
  resumed: boolean;
  replayTruncated: boolean;
};

type OutputFrame = { type: 'output'; generation: number; data: Buffer };
type AcceptedFrame = { type: 'input_accepted' | 'resize_accepted' | 'heartbeat'; generation: number };
type ExitFrame = { type: 'exit'; code: number };
type ErrorFrame = { type: 'error'; code: TerminalServerErrorCode };
type ServerFrame = ReadyFrame | OutputFrame | AcceptedFrame | ExitFrame | ErrorFrame;
type ExpectedFrame = ReadyFrame['type'] | AcceptedFrame['type'];
type OperationKind = 'attach' | 'heartbeat' | 'input' | 'resize';

interface PendingOperation {
  expected: ExpectedFrame;
  kind: OperationKind;
  sent: boolean;
  resolve: (frame: ReadyFrame | AcceptedFrame) => void;
  reject: (error: TerminalClientError) => void;
  cleanup: () => void;
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validateConfiguration(options: TerminalClientOptions) {
  if (isIP(options.host) === 0) throw new TypeError('Terminal host must be an IP address.');
  const port = options.port ?? DEFAULT_PORT;
  if (!validInteger(port, 1, 65_535)) throw new TypeError('Terminal port must be between 1 and 65535.');
  if (!validInteger(options.generation, 1, MAX_GENERATION)) {
    throw new TypeError('Terminal generation must be a positive safe integer.');
  }
  if (!validInteger(options.columns, 1, MAX_TERMINAL_DIMENSION)) {
    throw new TypeError('Terminal columns must be between 1 and 500.');
  }
  if (!validInteger(options.rows, 1, MAX_TERMINAL_DIMENSION)) {
    throw new TypeError('Terminal rows must be between 1 and 500.');
  }
  if (typeof options.onOutput !== 'function') throw new TypeError('Terminal output handler is required.');
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!validInteger(connectTimeoutMs, 1, 60_000)) {
    throw new TypeError('Terminal connect timeout must be between 1 and 60000 milliseconds.');
  }
  if (!validInteger(operationTimeoutMs, 1, 60_000)) {
    throw new TypeError('Terminal operation timeout must be between 1 and 60000 milliseconds.');
  }
  return { port, connectTimeoutMs, operationTimeoutMs };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeBase64(value: unknown): Buffer | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.length > MAX_OUTPUT_BYTES || decoded.toString('base64') !== value) {
    return undefined;
  }
  return decoded;
}

function parseServerFrame(line: Buffer): ServerFrame {
  let value: unknown;
  try {
    value = JSON.parse(line.toString('utf8'));
  } catch (cause) {
    throw new TerminalClientError('invalid_response', { cause });
  }
  if (!object(value) || typeof value.type !== 'string') throw new TerminalClientError('invalid_response');
  switch (value.type) {
    case 'ready':
      if (
        !exactKeys(value, ['type', 'version', 'generation', 'resumed', 'replayTruncated']) ||
        value.version !== PROTOCOL_VERSION ||
        !validInteger(value.generation, 1, MAX_GENERATION) ||
        typeof value.resumed !== 'boolean' ||
        typeof value.replayTruncated !== 'boolean'
      ) {
        throw new TerminalClientError('invalid_response');
      }
      return value as ReadyFrame;
    case 'output': {
      if (!exactKeys(value, ['type', 'generation', 'data']) || !validInteger(value.generation, 1, MAX_GENERATION)) {
        throw new TerminalClientError('invalid_response');
      }
      const data = decodeBase64(value.data);
      if (data === undefined) throw new TerminalClientError('invalid_response');
      return { type: 'output', generation: value.generation, data };
    }
    case 'input_accepted':
    case 'resize_accepted':
    case 'heartbeat':
      if (!exactKeys(value, ['type', 'generation']) || !validInteger(value.generation, 1, MAX_GENERATION)) {
        throw new TerminalClientError('invalid_response');
      }
      return value as AcceptedFrame;
    case 'exit':
      if (!exactKeys(value, ['type', 'code']) || !validInteger(value.code, -255, 255)) {
        throw new TerminalClientError('invalid_response');
      }
      return value as ExitFrame;
    case 'error':
      if (
        !exactKeys(value, ['type', 'code']) ||
        typeof value.code !== 'string' ||
        !terminalServerErrors.has(value.code as TerminalServerErrorCode)
      ) {
        throw new TerminalClientError('invalid_response');
      }
      return value as ErrorFrame;
    default:
      throw new TerminalClientError('invalid_response');
  }
}

function serverError(code: TerminalServerErrorCode): TerminalClientError {
  switch (code) {
    case 'INPUT_UNCERTAIN':
      return new TerminalClientError('input_uncertain', { serverCode: code });
    case 'REPLACED':
      return new TerminalClientError('replaced', { serverCode: code });
    case 'SHELL_EXITED':
      return new TerminalClientError('shell_exited', { serverCode: code });
    case 'STALE_GENERATION':
      return new TerminalClientError('stale_generation', { serverCode: code });
    default:
      return new TerminalClientError('server_rejected', { serverCode: code });
  }
}

function mapTransportError(cause: unknown): TerminalClientError {
  if (cause instanceof TerminalClientError) return cause;
  return new TerminalClientError('transport_failed', { cause });
}

function cancelled(signal?: AbortSignal): TerminalClientError | undefined {
  return signal?.aborted ? new TerminalClientError('cancelled', { cause: signal.reason }) : undefined;
}

function encodeFrame(frame: Record<string, unknown>): Buffer {
  const encoded = Buffer.from(JSON.stringify(frame) + '\n');
  if (encoded.length > MAX_LINE_BYTES) throw new TerminalClientError('invalid_response');
  return encoded;
}

function definiteInputRejection(error: TerminalClientError): boolean {
  return (
    error.code === 'input_uncertain' ||
    (error.code === 'shell_exited' && error.serverCode === 'SHELL_EXITED') ||
    error.code === 'stale_generation' ||
    (error.code === 'server_rejected' && error.serverCode !== undefined)
  );
}

export class TerminalClient {
  readonly ended: Promise<TerminalClientEnd>;

  private readonly socket: Socket;
  private readonly generation: number;
  private readonly onOutput: TerminalClientOptions['onOutput'];
  private readonly operationTimeoutMs: number;
  private readonly resolveEnded: (end: TerminalClientEnd) => void;
  private buffer = Buffer.alloc(0);
  private pending: PendingOperation | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private end?: TerminalClientEnd;
  private attached = false;

  private constructor(socket: Socket, options: TerminalClientOptions, operationTimeoutMs: number) {
    this.socket = socket;
    this.generation = options.generation;
    this.onOutput = options.onOutput;
    this.operationTimeoutMs = operationTimeoutMs;
    let resolveEnded!: (end: TerminalClientEnd) => void;
    this.ended = new Promise((resolve) => {
      resolveEnded = resolve;
    });
    this.resolveEnded = resolveEnded;
  }

  static async connect(
    options: TerminalClientOptions,
    signal?: AbortSignal,
  ): Promise<{ client: TerminalClient; ready: TerminalReady }> {
    const { port, connectTimeoutMs, operationTimeoutMs } = validateConfiguration(options);
    const cancelledError = cancelled(signal);
    if (cancelledError !== undefined) throw cancelledError;

    const socket = new Socket();
    const client = new TerminalClient(socket, options, operationTimeoutMs);
    try {
      await client.open(options.host, port, connectTimeoutMs, signal);
      const ready = await client.enqueue(() =>
        client.request(
          {
            type: 'attach',
            version: PROTOCOL_VERSION,
            mode: 'interactive',
            generation: options.generation,
            columns: options.columns,
            rows: options.rows,
          },
          'ready',
          'attach',
          signal,
        ),
      );
      if (ready.type !== 'ready') throw new TerminalClientError('invalid_response');
      return {
        client,
        ready: { resumed: ready.resumed, replayTruncated: ready.replayTruncated },
      };
    } catch (cause) {
      const error = mapTransportError(cause);
      client.finish({ reason: 'error', error }, error);
      throw error;
    }
  }

  input(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const value = Buffer.from(data);
    if (value.length === 0 || value.length > MAX_INPUT_BYTES) {
      return Promise.reject(new TypeError('Terminal input must contain between 1 and 16384 bytes.'));
    }
    return this.enqueue(async () => {
      await this.request(
        { type: 'input', generation: this.generation, data: value.toString('base64') },
        'input_accepted',
        'input',
        signal,
      );
    });
  }

  resize(columns: number, rows: number, signal?: AbortSignal): Promise<void> {
    if (!validInteger(columns, 1, MAX_TERMINAL_DIMENSION) || !validInteger(rows, 1, MAX_TERMINAL_DIMENSION)) {
      return Promise.reject(new TypeError('Terminal dimensions must be between 1 and 500.'));
    }
    return this.enqueue(async () => {
      await this.request(
        { type: 'resize', generation: this.generation, columns, rows },
        'resize_accepted',
        'resize',
        signal,
      );
    });
  }

  heartbeat(signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      await this.request({ type: 'heartbeat', generation: this.generation }, 'heartbeat', 'heartbeat', signal);
    });
  }

  close(): void {
    this.finish({ reason: 'closed' }, new TerminalClientError('closed'));
  }

  private async open(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutError = new TerminalClientError('connect_timeout');
      const timeout = setTimeout(() => finish(timeoutError), timeoutMs);
      const onAbort = () => finish(new TerminalClientError('cancelled', { cause: signal?.reason }));
      const onConnect = () => finish();
      const onError = (cause: unknown) => finish(mapTransportError(cause));
      const finish = (error?: TerminalClientError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        this.socket.removeListener('connect', onConnect);
        this.socket.removeListener('error', onError);
        if (error !== undefined) {
          this.socket.destroy();
          reject(error);
          return;
        }
        this.socket.setNoDelay(true);
        void this.readLoop();
        resolve();
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
      this.socket.connect({ host, port });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private request(
    frame: Record<string, unknown>,
    expected: ExpectedFrame,
    kind: OperationKind,
    signal?: AbortSignal,
  ): Promise<ReadyFrame | AcceptedFrame> {
    const terminalError = this.currentError();
    if (terminalError !== undefined) return Promise.reject(terminalError);
    const cancelledError = cancelled(signal);
    if (cancelledError !== undefined) return Promise.reject(cancelledError);
    if (this.pending !== undefined) return Promise.reject(new TerminalClientError('invalid_response'));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new TerminalClientError('operation_timeout');
        this.finish({ reason: 'error', error }, error);
      }, this.operationTimeoutMs);
      const onAbort = () => {
        const error = new TerminalClientError('cancelled', { cause: signal?.reason });
        this.finish({ reason: 'error', error }, error);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
      };
      const pending: PendingOperation = { expected, kind, sent: false, resolve, reject, cleanup };
      this.pending = pending;
      signal?.addEventListener('abort', onAbort, { once: true });

      const payload = encodeFrame(frame);
      pending.sent = true;
      try {
        this.socket.write(payload, (cause) => {
          if (cause == null || this.pending !== pending) return;
          const error = mapTransportError(cause);
          this.finish({ reason: 'error', error }, error);
        });
      } catch (cause) {
        const error = mapTransportError(cause);
        this.finish({ reason: 'error', error }, error);
      }
    });
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.socket) {
        if (this.end !== undefined) return;
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
        while (true) {
          const newline = this.buffer.indexOf(0x0a);
          if (newline < 0) break;
          if (newline + 1 > MAX_LINE_BYTES || newline === 0) throw new TerminalClientError('invalid_response');
          const line = this.buffer.subarray(0, newline);
          this.buffer = this.buffer.subarray(newline + 1);
          await this.dispatch(parseServerFrame(line));
          if (this.end !== undefined) return;
        }
        if (this.buffer.length > MAX_LINE_BYTES) throw new TerminalClientError('invalid_response');
      }
      if (this.end === undefined) {
        const error = new TerminalClientError('transport_failed');
        this.finish({ reason: 'error', error }, error);
      }
    } catch (cause) {
      if (this.end !== undefined) return;
      const error = mapTransportError(cause);
      this.finish({ reason: 'error', error }, error);
    }
  }

  private async dispatch(frame: ServerFrame): Promise<void> {
    if (frame.type === 'output') {
      if (!this.attached || frame.generation !== this.generation) throw new TerminalClientError('invalid_response');
      try {
        await this.onOutput(frame.data);
      } catch (cause) {
        throw new TerminalClientError('output_failed', { cause });
      }
      return;
    }
    if (frame.type === 'exit') {
      this.finish({ reason: 'exit', code: frame.code }, new TerminalClientError('shell_exited'));
      return;
    }
    if (frame.type === 'error') {
      const error = serverError(frame.code);
      this.finish({ reason: 'error', error }, error);
      return;
    }

    const pending = this.pending;
    if (pending === undefined || pending.expected !== frame.type || frame.generation !== this.generation) {
      throw new TerminalClientError('invalid_response');
    }
    if (frame.type === 'ready') this.attached = true;
    this.pending = undefined;
    pending.cleanup();
    pending.resolve(frame);
  }

  private currentError(): TerminalClientError | undefined {
    if (this.end === undefined) return undefined;
    if (this.end.reason === 'error') return this.end.error;
    if (this.end.reason === 'exit') return new TerminalClientError('shell_exited');
    return new TerminalClientError('closed');
  }

  private finish(end: TerminalClientEnd, error: TerminalClientError): void {
    if (this.end !== undefined) return;
    this.end = end;
    const pending = this.pending;
    this.pending = undefined;
    if (pending !== undefined) {
      pending.cleanup();
      const rejection =
        pending.kind === 'input' && pending.sent && !definiteInputRejection(error)
          ? new TerminalClientError('input_uncertain', { cause: error })
          : error;
      pending.reject(rejection);
    }
    this.socket.destroy();
    this.resolveEnded(end);
  }
}
