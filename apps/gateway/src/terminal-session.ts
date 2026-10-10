import { randomUUID } from 'node:crypto';
import { TerminalClient, type TerminalClientEnd, type TerminalClientOptions } from './terminal-client.js';
import {
  TerminalAdmissionError,
  type TerminalAdmission,
  type TerminalAdmissionStore,
} from './terminal-admission-store.js';

export interface TerminalConnection {
  readonly ended: Promise<TerminalClientEnd>;
  input(data: Uint8Array, signal?: AbortSignal): Promise<void>;
  resize(columns: number, rows: number, signal?: AbortSignal): Promise<void>;
  heartbeat(signal?: AbortSignal): Promise<void>;
  close(): void;
}

export interface TerminalConnectorResult {
  client: TerminalConnection;
  ready: { resumed: boolean; replayTruncated: boolean };
}

export type TerminalConnector = (
  options: TerminalClientOptions,
  signal?: AbortSignal,
) => Promise<TerminalConnectorResult>;

export interface OpenTerminalSessionOptions {
  sessionId: string;
  ticket: string;
  columns: number;
  rows: number;
  onOutput: (data: Buffer) => void | Promise<void>;
  terminalPort?: number;
}

export interface OpenTerminalSessionDependencies {
  admissions: TerminalAdmissionStore;
  connect?: TerminalConnector;
  newConnectionId?: () => string;
  now?: () => Date;
}

export interface TerminalSessionReady {
  sessionId: string;
  generation: number;
  resumed: boolean;
  replayTruncated: boolean;
}

export class GatewayTerminalSession {
  readonly ended: Promise<TerminalClientEnd>;
  readonly sessionId: string;
  readonly generation: number;

  private constructor(
    private readonly admission: TerminalAdmission,
    private readonly admissions: TerminalAdmissionStore,
    private readonly terminal: TerminalConnection,
  ) {
    this.sessionId = admission.sessionId;
    this.generation = admission.generation;
    this.ended = terminal.ended;
  }

  static async open(
    options: OpenTerminalSessionOptions,
    dependencies: OpenTerminalSessionDependencies,
    signal?: AbortSignal,
  ): Promise<{ session: GatewayTerminalSession; ready: TerminalSessionReady }> {
    const connectionId = (dependencies.newConnectionId ?? randomUUID)();
    const now = (dependencies.now ?? (() => new Date()))().toISOString();
    const admission = await dependencies.admissions.admit(
      {
        sessionId: options.sessionId,
        ticket: options.ticket,
        connectionId,
        now,
      },
      signal,
    );
    const connect = dependencies.connect ?? TerminalClient.connect;
    const connected = await connect(
      {
        host: admission.taskAddress,
        ...(options.terminalPort === undefined ? {} : { port: options.terminalPort }),
        generation: admission.generation,
        columns: options.columns,
        rows: options.rows,
        onOutput: options.onOutput,
      },
      signal,
    );
    return {
      session: new GatewayTerminalSession(admission, dependencies.admissions, connected.client),
      ready: {
        sessionId: admission.sessionId,
        generation: admission.generation,
        resumed: connected.ready.resumed,
        replayTruncated: connected.ready.replayTruncated,
      },
    };
  }

  async input(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.authorize(signal);
    await this.terminal.input(data, signal);
  }

  async resize(columns: number, rows: number, signal?: AbortSignal): Promise<void> {
    await this.authorize(signal);
    await this.terminal.resize(columns, rows, signal);
  }

  async heartbeat(signal?: AbortSignal): Promise<void> {
    await this.authorize(signal);
    await this.terminal.heartbeat(signal);
  }

  close(): void {
    this.terminal.close();
  }

  private async authorize(signal?: AbortSignal): Promise<void> {
    try {
      await this.admissions.authorizeInput(
        {
          sessionId: this.admission.sessionId,
          connectionId: this.admission.connectionId,
          generation: this.admission.generation,
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof TerminalAdmissionError &&
        ['session_not_ready', 'session_terminal', 'replaced', 'invalid_store'].includes(error.code)
      ) {
        this.terminal.close();
      }
      throw error;
    }
  }
}
