import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createGatewayAwsClients, type GatewayAwsClients } from './aws.js';
import { GatewayBrowserTerminalRelay, type GatewayBrowserTerminalRelayOptions } from './browser-terminal-relay.js';
import {
  createGatewayRecordingSupervisor,
  type GatewayRecordingServiceClients,
  type GatewayRecordingServiceOptions,
} from './recording-service.js';
import type { MonitorRecordingSupervisorEvent } from './monitor-recording-supervisor.js';
import { DynamoTerminalAdmissionStore, type TerminalAdmissionStore } from './terminal-admission-store.js';

const listenHost = '0.0.0.0';
const healthPath = '/healthz';
const healthBody = '{"status":"ready"}\n';
const maximumAllowedOrigins = 16;
const maximumAllowedOriginsCharacters = 4_096;
const maximumTerminalConnections = 4_096;
const maximumPendingTerminalAuthentications = 1_024;

export interface GatewayTerminalRuntimeConfiguration {
  listenPort: number;
  allowedOrigins: readonly string[];
  maximumConnections: number;
  maximumPendingAuthentications: number;
  terminalPort: number;
}

export interface GatewayRuntimeConfiguration {
  sessionTableName: string;
  recordingBucketName: string;
  maximumConcurrentRecordings: number;
  monitorPort: number;
  terminal: GatewayTerminalRuntimeConfiguration | null;
}

export type GatewayRuntimeEvent =
  | {
      type: 'service_started';
      recorderId: string;
      maximumConcurrentRecordings: number;
      listenPort: number | null;
    }
  | { type: 'service_stopped'; recorderId: string }
  | MonitorRecordingSupervisorEvent;

interface RecordingSupervisor {
  run(signal: AbortSignal): Promise<void>;
}

interface BrowserTerminalRelay {
  close(): Promise<void>;
}

export interface GatewayRuntimeDependencies {
  createClients: () => GatewayAwsClients;
  createSupervisor: (
    options: GatewayRecordingServiceOptions,
    clients: GatewayRecordingServiceClients,
  ) => RecordingSupervisor;
  createAdmissions: (client: DynamoDBDocumentClient, tableName: string) => TerminalAdmissionStore;
  createRelay: (server: HttpServer, options: GatewayBrowserTerminalRelayOptions) => BrowserTerminalRelay;
  createHttpServer: (listener: (request: IncomingMessage, response: ServerResponse) => void) => HttpServer;
  createRecorderId: () => string;
  report: (event: GatewayRuntimeEvent) => void;
}

const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const bucketPattern = /^(?=.{3,63}$)(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const terminalEnvironmentNames = [
  'GATEWAY_PORT',
  'TERMINAL_ALLOWED_ORIGINS',
  'MAXIMUM_TERMINAL_CONNECTIONS',
  'MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS',
  'TERMINAL_PORT',
] as const;

export function createGatewayRecorderId(): string {
  return `gateway-${randomUUID()}`;
}

function integer(environment: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number): number {
  const raw = environment[name];
  if (!raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function identifier(environment: NodeJS.ProcessEnv, name: string, pattern: RegExp): string {
  const value = environment[name];
  if (!value || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function allowedOrigins(environment: NodeJS.ProcessEnv): readonly string[] {
  const raw = environment.TERMINAL_ALLOWED_ORIGINS;
  if (!raw || raw.length > maximumAllowedOriginsCharacters) throw new Error('TERMINAL_ALLOWED_ORIGINS is invalid');
  const values = raw.split(',').map((value) => value.trim());
  if (values.length > maximumAllowedOrigins || values.some((value) => value.length === 0)) {
    throw new Error('TERMINAL_ALLOWED_ORIGINS is invalid');
  }
  const canonical = values.map((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('TERMINAL_ALLOWED_ORIGINS is invalid');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('TERMINAL_ALLOWED_ORIGINS is invalid');
    }
    return parsed.origin;
  });
  if (new Set(canonical).size !== canonical.length) throw new Error('TERMINAL_ALLOWED_ORIGINS is invalid');
  return canonical;
}

function terminalConfiguration(environment: NodeJS.ProcessEnv): GatewayTerminalRuntimeConfiguration | null {
  const supplied = terminalEnvironmentNames.filter((name) => environment[name] !== undefined);
  if (supplied.length === 0) return null;
  if (supplied.length !== terminalEnvironmentNames.length) {
    throw new Error('Terminal runtime configuration is incomplete');
  }
  const maximumConnections = integer(environment, 'MAXIMUM_TERMINAL_CONNECTIONS', 1, maximumTerminalConnections);
  const pending = integer(
    environment,
    'MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS',
    1,
    maximumPendingTerminalAuthentications,
  );
  if (pending > maximumConnections) {
    throw new Error('MAXIMUM_PENDING_TERMINAL_AUTHENTICATIONS is invalid');
  }
  return {
    listenPort: integer(environment, 'GATEWAY_PORT', 1, 65_535),
    allowedOrigins: allowedOrigins(environment),
    maximumConnections,
    maximumPendingAuthentications: pending,
    terminalPort: integer(environment, 'TERMINAL_PORT', 1, 65_535),
  };
}

export function loadGatewayRuntimeConfiguration(environment: NodeJS.ProcessEnv): GatewayRuntimeConfiguration {
  return {
    sessionTableName: identifier(environment, 'SESSION_TABLE_NAME', tableNamePattern),
    recordingBucketName: identifier(environment, 'RECORDING_BUCKET_NAME', bucketPattern),
    maximumConcurrentRecordings: integer(environment, 'MAXIMUM_CONCURRENT_RECORDINGS', 1, 64),
    monitorPort: integer(environment, 'MONITOR_PORT', 1, 65_535),
    terminal: terminalConfiguration(environment),
  };
}

function requestHandler(isReady: () => boolean): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === healthPath) {
      const ready = isReady();
      const body = ready ? healthBody : '';
      response.statusCode = ready ? 200 : 503;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Content-Length', Buffer.byteLength(body));
      response.end(body);
      return;
    }
    response.statusCode = 404;
    response.setHeader('Content-Length', '0');
    response.end();
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Gateway runtime was cancelled.');
  error.name = 'AbortError';
  return error;
}

function listen(server: HttpServer, port: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('error', failed);
      signal.removeEventListener('abort', cancelled);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cancelled = () => {
      cleanup();
      server.close(() => {});
      reject(abortReason(signal));
    };
    server.once('error', failed);
    signal.addEventListener('abort', cancelled, { once: true });
    server.listen(port, listenHost, () => {
      cleanup();
      resolve();
    });
  });
}

function closeServer(server: HttpServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeIdleConnections();
  });
}

function listeningPort(server: HttpServer): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Gateway listener address is invalid.');
  return (address as AddressInfo).port;
}

const defaultDependencies: GatewayRuntimeDependencies = {
  createClients: createGatewayAwsClients,
  createSupervisor: createGatewayRecordingSupervisor,
  createAdmissions: (client, tableName) => new DynamoTerminalAdmissionStore(client, tableName),
  createRelay: (server, options) => new GatewayBrowserTerminalRelay(server, options),
  createHttpServer: (listener) =>
    createServer(
      {
        headersTimeout: 5_000,
        keepAliveTimeout: 5_000,
        maxHeaderSize: 16 * 1024,
        requestTimeout: 5_000,
      },
      listener,
    ),
  createRecorderId: createGatewayRecorderId,
  report: (event) => console.info(JSON.stringify({ component: 'gateway', ...event })),
};

function safeReport(report: GatewayRuntimeDependencies['report'], event: GatewayRuntimeEvent): void {
  try {
    report(event);
  } catch {
    /* Reporting must not change service state. */
  }
}

function firstRejected(results: PromiseSettledResult<unknown>[]): unknown | undefined {
  return results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
}

export async function runGatewayRuntime(
  configuration: GatewayRuntimeConfiguration,
  signal: AbortSignal,
  dependencies: GatewayRuntimeDependencies = defaultDependencies,
): Promise<void> {
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();

  const recorderId = dependencies.createRecorderId();
  const clients = dependencies.createClients();
  let server: HttpServer | undefined;
  let relay: BrowserTerminalRelay | undefined;
  let supervisorTask: Promise<void> | undefined;
  let serverErrorListener: ((error: Error) => void) | undefined;
  let ready = false;
  let closeTask: Promise<void> | undefined;
  let closeFailure: unknown;
  let failure: unknown;

  const closeTerminal = (): Promise<void> => {
    closeTask ??= (async () => {
      ready = false;
      const closing = server === undefined ? Promise.resolve() : closeServer(server);
      const results = await Promise.allSettled([relay?.close() ?? Promise.resolve(), closing]);
      closeFailure = firstRejected(results);
    })();
    return closeTask;
  };
  const closeOnAbort = () => void closeTerminal();
  lifetime.signal.addEventListener('abort', closeOnAbort, { once: true });

  try {
    const supervisor = dependencies.createSupervisor(
      {
        sessionTableName: configuration.sessionTableName,
        recordingBucketName: configuration.recordingBucketName,
        maximumConcurrentRecordings: configuration.maximumConcurrentRecordings,
        monitorPort: configuration.monitorPort,
        recorderId,
        report: (event) => safeReport(dependencies.report, event),
      },
      clients,
    );

    if (configuration.terminal !== null) {
      server = dependencies.createHttpServer(requestHandler(() => ready));
      const admissions = dependencies.createAdmissions(clients.dynamo, configuration.sessionTableName);
      relay = dependencies.createRelay(server, {
        allowedOrigins: configuration.terminal.allowedOrigins,
        admissions,
        maxConnections: configuration.terminal.maximumConnections,
        maxPendingAuthentications: configuration.terminal.maximumPendingAuthentications,
        terminalPort: configuration.terminal.terminalPort,
      });
      await listen(server, configuration.terminal.listenPort, lifetime.signal);
      ready = true;
    }

    supervisorTask = supervisor.run(lifetime.signal);
    safeReport(dependencies.report, {
      type: 'service_started',
      recorderId,
      maximumConcurrentRecordings: configuration.maximumConcurrentRecordings,
      listenPort: server === undefined ? null : listeningPort(server),
    });

    if (server === undefined) {
      await supervisorTask;
    } else {
      const serverFailure = new Promise<never>((_resolve, reject) => {
        serverErrorListener = reject;
        server!.once('error', serverErrorListener);
      });
      await Promise.race([supervisorTask, serverFailure]);
    }
  } catch (error) {
    if (!signal.aborted) failure = error;
  } finally {
    lifetime.abort(failure);
    await closeTerminal();
    const completion = supervisorTask === undefined ? [] : await Promise.allSettled([supervisorTask]);
    if (failure === undefined) failure = firstRejected(completion) ?? closeFailure;
    if (server !== undefined && serverErrorListener !== undefined) server.off('error', serverErrorListener);
    lifetime.signal.removeEventListener('abort', closeOnAbort);
    signal.removeEventListener('abort', cancel);
    try {
      clients.close();
    } catch (error) {
      failure ??= error;
    }
    safeReport(dependencies.report, { type: 'service_stopped', recorderId });
  }
  if (failure !== undefined) throw failure;
}
