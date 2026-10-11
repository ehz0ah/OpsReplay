import { isIP, Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import {
  isTerminalRecordingPage,
  isTerminalRecordingRead,
  isTerminalRecordingReady,
  terminalRecordingSchema,
  type TerminalRecordingMetadata,
  type TerminalRecordingPage,
  type TerminalRecordingReady,
} from '../../../packages/contracts/private/terminal-recording.js';

export type TerminalRecordingClientErrorCode =
  | 'invalid_config'
  | 'invalid_request'
  | 'busy'
  | 'cancelled'
  | 'closed'
  | 'connect_timeout'
  | 'request_timeout'
  | 'transport_failed'
  | 'invalid_response'
  | 'server_rejected';

const messages: Record<TerminalRecordingClientErrorCode, string> = {
  invalid_config: 'Terminal recording client configuration is invalid.',
  invalid_request: 'Terminal recording read request is invalid.',
  busy: 'Terminal recording client already has an operation in progress.',
  cancelled: 'Terminal recording operation was cancelled.',
  closed: 'Terminal recording client is closed.',
  connect_timeout: 'Terminal recording connection timed out.',
  request_timeout: 'Terminal recording response timed out.',
  transport_failed: 'Terminal recording connection failed.',
  invalid_response: 'Terminal recording source returned an invalid response.',
  server_rejected: 'Terminal recording source rejected the request.',
};

export type TerminalRecordingServerErrorCode =
  'FRAME_TOO_LARGE' | 'IDLE_TIMEOUT' | 'INVALID_FRAME' | 'SOURCE_MISMATCH' | 'INVALID_CURSOR' | 'RATE_LIMITED';
const serverCodes = new Set<TerminalRecordingServerErrorCode>([
  'FRAME_TOO_LARGE',
  'IDLE_TIMEOUT',
  'INVALID_FRAME',
  'SOURCE_MISMATCH',
  'INVALID_CURSOR',
  'RATE_LIMITED',
]);

/** Fixed diagnostics only. Never retain remote payloads, addresses, or arbitrary causes. */
export class TerminalRecordingClientError extends Error {
  constructor(
    readonly code: TerminalRecordingClientErrorCode,
    readonly serverCode?: TerminalRecordingServerErrorCode,
  ) {
    super(messages[code]);
    this.name = 'TerminalRecordingClientError';
  }
}

export interface TerminalRecordingClientOptions {
  host: string;
  port?: number;
  expectedSource?: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export type TerminalRecordingClientEnd =
  { reason: 'closed' } | { reason: 'error'; error: TerminalRecordingClientError };

type Pending = {
  type: 'recording_ready' | 'recording_page';
  after: number;
  resolve: (value: TerminalRecordingReady | TerminalRecordingPage) => void;
  reject: (error: TerminalRecordingClientError) => void;
  cleanup: () => void;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const phases = { running: 0, exiting: 1, exited: 2 };

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function configuration(options: TerminalRecordingClientOptions) {
  const port = options.port ?? 7681;
  const connectTimeoutMs = options.connectTimeoutMs ?? 3_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  if (
    typeof options.host !== 'string' ||
    isIP(options.host) === 0 ||
    !integer(port, 1, 65_535) ||
    !integer(connectTimeoutMs, 1, 60_000) ||
    !integer(requestTimeoutMs, 1, 60_000) ||
    (options.expectedSource !== undefined &&
      !isTerminalRecordingRead({ type: 'read', source: options.expectedSource, after: 0 }))
  )
    throw new TerminalRecordingClientError('invalid_config');
  return { port, connectTimeoutMs, requestTimeoutMs };
}

/** Bounded source JSON only, not a general parser. JSON.parse checks syntax after this scan. */
function parse(line: Buffer): unknown {
  try {
    const text = utf8.decode(line);
    const stack: Array<{ object: boolean; keys: Set<string>; key: boolean }> = [];
    for (let i = 0; i < text.length; i++) {
      const character = text[i];
      const top = stack.at(-1);
      if (character === '"') {
        const start = i;
        for (i++; i < text.length && text[i] !== '"'; i++) {
          if (text[i] === '\\') i++;
        }
        if (i >= text.length) throw new Error();
        if (top?.object && top.key) {
          const key = JSON.parse(text.slice(start, i + 1)) as string;
          if (top.keys.has(key)) throw new Error();
          top.keys.add(key);
          top.key = false;
        }
      } else if (character === '{' || character === '[') {
        if (stack.length >= 8) throw new Error();
        stack.push({ object: character === '{', keys: new Set(), key: true });
      } else if (character === '}' || character === ']') {
        stack.pop();
      } else if (character === ',' && top?.object) {
        top.key = true;
      }
    }
    return JSON.parse(text) as unknown;
  } catch {
    throw new TerminalRecordingClientError('invalid_response');
  }
}

function remoteError(value: unknown): TerminalRecordingClientError | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (frame.type !== 'error') return undefined;
  if (
    Object.keys(frame).length !== 2 ||
    typeof frame.code !== 'string' ||
    !serverCodes.has(frame.code as TerminalRecordingServerErrorCode)
  )
    throw new TerminalRecordingClientError('invalid_response');
  return new TerminalRecordingClientError('server_rejected', frame.code as TerminalRecordingServerErrorCode);
}

function sameEvent(a: TerminalRecordingPage['events'][number], b: TerminalRecordingPage['events'][number]): boolean {
  if (a.sequence !== b.sequence || a.recordedAt !== b.recordedAt || a.type !== b.type) return false;
  if ((a.type === 'input' || a.type === 'output') && (b.type === 'input' || b.type === 'output'))
    return a.data === b.data;
  if (a.type === 'dimensions' && b.type === 'dimensions') return a.columns === b.columns && a.rows === b.rows;
  return a.type === 'exit' && b.type === 'exit' && a.code === b.code;
}

/** Explicit read cursors belong to the caller. Receiving a page never commits a durable cursor. */
export class TerminalRecordingClient {
  readonly ended: Promise<TerminalRecordingClientEnd>;
  private readonly socket = new Socket();
  private readonly line = Buffer.alloc(terminalRecordingSchema.maximumResponseBytes);
  private used = 0;
  private pending: Pending | undefined;
  private end: TerminalRecordingClientEnd | undefined;
  private readonly resolveEnded: (value: TerminalRecordingClientEnd) => void;
  private metadata: TerminalRecordingMetadata | undefined;
  private lossSequence: number | undefined;
  private frontier: TerminalRecordingPage['events'][number] | undefined;
  private previousPageEnd: { sequence: number; recordedAt: string } | undefined;

  private constructor(
    private readonly options: TerminalRecordingClientOptions,
    private readonly requestTimeoutMs: number,
  ) {
    let resolve!: (value: TerminalRecordingClientEnd) => void;
    this.ended = new Promise((done) => {
      resolve = done;
    });
    this.resolveEnded = resolve;
    this.socket.on('data', (chunk: Buffer) => this.receive(chunk));
    this.socket.on('error', () => this.fail('transport_failed'));
    this.socket.on('end', () => this.fail('transport_failed'));
    this.socket.on('close', () => {
      if (this.end === undefined) this.fail('transport_failed');
    });
  }

  static async connect(
    options: TerminalRecordingClientOptions,
    signal?: AbortSignal,
  ): Promise<{ client: TerminalRecordingClient; ready: TerminalRecordingReady }> {
    const config = configuration(options);
    if (signal?.aborted) throw new TerminalRecordingClientError('cancelled');
    const client = new TerminalRecordingClient({ ...options }, config.requestTimeoutMs);
    try {
      await client.open(config.port, config.connectTimeoutMs, signal);
      const value = await client.request(
        { type: 'attach', version: terminalRecordingSchema.version, mode: 'recording' },
        'recording_ready',
        0,
        signal,
      );
      client.checkOpen();
      if (value.type !== 'recording_ready') throw new TerminalRecordingClientError('invalid_response');
      return { client, ready: value };
    } catch (error) {
      const failure =
        error instanceof TerminalRecordingClientError ? error : new TerminalRecordingClientError('transport_failed');
      client.finish({ reason: 'error', error: failure });
      throw client.currentError() ?? failure;
    }
  }

  async read(after: number, signal?: AbortSignal): Promise<TerminalRecordingPage> {
    this.checkOpen();
    const source = this.metadata!.source;
    if (!isTerminalRecordingRead({ type: 'read', source, after }))
      throw new TerminalRecordingClientError('invalid_request');
    const value = await this.request({ type: 'read', source, after }, 'recording_page', after, signal);
    this.checkOpen();
    if (value.type !== 'recording_page') throw new TerminalRecordingClientError('invalid_response');
    return value;
  }

  close(): void {
    this.finish({ reason: 'closed' });
  }

  private open(port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => done(new TerminalRecordingClientError('connect_timeout')), timeoutMs);
      const onAbort = () => done(new TerminalRecordingClientError('cancelled'));
      const onClose = () => done(this.currentError() ?? new TerminalRecordingClientError('transport_failed'));
      const onConnect = () => done();
      const done = (error?: TerminalRecordingClientError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.socket.removeListener('close', onClose);
        this.socket.removeListener('connect', onConnect);
        if (error) {
          this.finish({ reason: 'error', error });
          reject(error);
        } else {
          this.socket.setNoDelay(true);
          resolve();
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket.once('close', onClose);
      this.socket.once('connect', onConnect);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.socket.connect({ host: this.options.host, port });
      } catch {
        done(new TerminalRecordingClientError('transport_failed'));
      }
    });
  }

  private request(
    frame: object,
    type: Pending['type'],
    after: number,
    signal?: AbortSignal,
  ): Promise<TerminalRecordingReady | TerminalRecordingPage> {
    this.checkOpen();
    if (signal?.aborted) return Promise.reject(new TerminalRecordingClientError('cancelled'));
    if (this.pending) return Promise.reject(new TerminalRecordingClientError('busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('request_timeout'), this.requestTimeoutMs);
      const onAbort = () => this.fail('cancelled');
      this.pending = {
        type,
        after,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.socket.write(JSON.stringify(frame) + '\n', (error) => {
          if (error) this.fail('transport_failed');
        });
      } catch {
        this.fail('transport_failed');
      }
    });
  }

  private receive(chunk: Buffer): void {
    if (this.end !== undefined) return;
    try {
      const newline = chunk.indexOf(0x0a);
      // Idle source errors are terminal controls, not responses to a later read.
      // Require the whole frame now; never buffer unsolicited partial bytes.
      if (!this.pending && newline < 0) throw new TerminalRecordingClientError('invalid_response');
      const size = newline < 0 ? chunk.length : newline;
      // The cap includes newline, including when newline arrives in a later chunk.
      if (this.used + size + 1 > this.line.length) throw new TerminalRecordingClientError('invalid_response');
      chunk.copy(this.line, this.used, 0, size);
      this.used += size;
      if (newline < 0) return;
      // A partial second frame is unsolicited too. Do not leave it for a later read.
      if (this.used === 0 || newline + 1 !== chunk.length) throw new TerminalRecordingClientError('invalid_response');
      const value = parse(this.line.subarray(0, this.used));
      this.line.fill(0, 0, this.used);
      this.used = 0;
      this.dispatch(value);
    } catch (error) {
      this.finish({
        reason: 'error',
        error:
          error instanceof TerminalRecordingClientError ? error : new TerminalRecordingClientError('invalid_response'),
      });
    }
  }

  private dispatch(value: unknown): void {
    const rejected = remoteError(value);
    if (rejected) throw rejected;
    const pending = this.pending;
    if (!pending) throw new TerminalRecordingClientError('invalid_response');
    if (pending.type === 'recording_ready') {
      if (
        !isTerminalRecordingReady(value) ||
        (this.options.expectedSource !== undefined && value.source !== this.options.expectedSource)
      ) {
        throw new TerminalRecordingClientError('invalid_response');
      }
      this.observe(value);
    } else {
      const previous = this.metadata!;
      if (!isTerminalRecordingPage(value, previous.source, pending.after))
        throw new TerminalRecordingClientError('invalid_response');
      if (
        value.events.some((event) => event.sequence > previous.latestSequence && event.recordedAt < previous.observedAt)
      ) {
        throw new TerminalRecordingClientError('invalid_response');
      }
      this.observe(value);
      const first = value.events[0];
      if (
        first &&
        this.previousPageEnd?.sequence === pending.after &&
        first.recordedAt < this.previousPageEnd.recordedAt
      ) {
        throw new TerminalRecordingClientError('invalid_response');
      }
      const frontier = this.frontier;
      if (frontier) {
        for (const event of value.events) {
          if (
            (event.sequence < frontier.sequence && event.recordedAt > frontier.recordedAt) ||
            (event.sequence > frontier.sequence && event.recordedAt < frontier.recordedAt) ||
            (event.sequence === frontier.sequence && !sameEvent(event, frontier))
          ) {
            throw new TerminalRecordingClientError('invalid_response');
          }
        }
      }
      const last = value.events.at(-1);
      if (last) {
        this.previousPageEnd = { sequence: last.sequence, recordedAt: last.recordedAt };
        if (!frontier || last.sequence > frontier.sequence) this.frontier = { ...last };
      }
    }
    this.pending = undefined;
    pending.cleanup();
    pending.resolve(value);
  }

  private observe(value: TerminalRecordingMetadata): void {
    const previous = this.metadata;
    if (
      previous &&
      (value.source !== previous.source ||
        value.startedAt !== previous.startedAt ||
        value.observedAt < previous.observedAt ||
        value.latestSequence < previous.latestSequence ||
        phases[value.shellState] < phases[previous.shellState] ||
        (previous.shellState !== 'exited' &&
          value.shellState === 'exited' &&
          value.latestSequence === previous.latestSequence) ||
        (previous.shellState === 'exited' &&
          (value.latestSequence !== previous.latestSequence ||
            value.loss?.reason !== previous.loss?.reason ||
            value.loss?.occurredAt !== previous.loss?.occurredAt)) ||
        (previous.loss === null && value.loss !== null && value.loss.occurredAt < previous.observedAt) ||
        (previous.loss !== null &&
          (value.loss === null ||
            value.loss.reason !== previous.loss.reason ||
            value.loss.occurredAt !== previous.loss.occurredAt)) ||
        (this.lossSequence !== undefined &&
          value.latestSequence !== this.lossSequence &&
          !(value.shellState === 'exited' && value.latestSequence === this.lossSequence + 1)))
    )
      throw new TerminalRecordingClientError('invalid_response');
    if (value.loss !== null && this.lossSequence === undefined && value.shellState !== 'exited')
      this.lossSequence = value.latestSequence;
    this.metadata = {
      version: value.version,
      source: value.source,
      startedAt: value.startedAt,
      initialColumns: value.initialColumns,
      initialRows: value.initialRows,
      latestSequence: value.latestSequence,
      observedAt: value.observedAt,
      shellState: value.shellState,
      loss: value.loss === null ? null : { ...value.loss },
    };
  }

  private currentError(): TerminalRecordingClientError | undefined {
    if (!this.end) return undefined;
    return this.end.reason === 'error' ? this.end.error : new TerminalRecordingClientError('closed');
  }
  private checkOpen(): void {
    const error = this.currentError();
    if (error) throw error;
  }
  private fail(code: TerminalRecordingClientErrorCode): void {
    this.finish({ reason: 'error', error: new TerminalRecordingClientError(code) });
  }
  private finish(value: TerminalRecordingClientEnd): void {
    if (this.end) return;
    this.end = value;
    const pending = this.pending;
    this.pending = undefined;
    pending?.cleanup();
    pending?.reject(this.currentError()!);
    this.line.fill(0);
    this.used = 0;
    this.frontier = undefined;
    this.previousPageEnd = undefined;
    this.socket.destroy();
    this.resolveEnded(value);
  }
}
