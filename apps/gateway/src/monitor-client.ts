import { X509Certificate, timingSafeEqual } from 'node:crypto';
import { Agent, request } from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { isIP } from 'node:net';
import type { PeerCertificate } from 'node:tls';
import { MIMEType } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';
import type {
  MonitorControlClientErrorCode,
  MonitorControlFrame,
  MonitorControlFramePage,
  MonitorControlHealth,
  MonitorControlSealRequest,
  MonitorControlSealResponse,
} from '../../../packages/contracts/private/monitor-control.js';
import {
  isMonitorControlFramePage,
  isMonitorControlHealthResponse,
  isMonitorControlSealResponse,
  isMonitorControlSource,
  isMonitorControlStartResponse,
  isMonitorControlTimestamp,
  monitorControlClientError,
  monitorControlSchema,
} from '../../../packages/contracts/private/monitor-control.js';

export type MonitorHealth = MonitorControlHealth;
export interface MonitorMetricFrame {
  type: 'metrics';
  sample: { at: string; values: Record<string, number> };
  counters: { totalRequests: number; failedRequests: number };
  recovery: { state: 'failing' | 'sustaining' | 'met'; sustainedSeconds: number; requiredSeconds: number };
}
export interface MonitorTimelineFrame {
  type: 'timeline';
  event: {
    id: string;
    at: string;
    kind: 'monitor';
    signal: 'recovery_sustaining' | 'recovery_lost' | 'recovered' | 'outage_started' | 'outage_ended';
    label: string;
  };
}
export type MonitorPayload = MonitorMetricFrame | MonitorTimelineFrame;
export type MonitorFrame = MonitorControlFrame<MonitorPayload>;
export type MonitorFramePage = MonitorControlFramePage<MonitorPayload>;
export type MonitorSealResult = MonitorControlSealResponse<MonitorMetricFrame>;

export type MonitorClientErrorCode =
  | 'invalid_config'
  | 'closed'
  | 'cancelled'
  | 'request_timeout'
  | 'tls_failed'
  | 'transport_failed'
  | 'invalid_response'
  | MonitorControlClientErrorCode;

const errorMessages: Record<MonitorClientErrorCode, string> = {
  invalid_config: 'Monitor client configuration is invalid.',
  closed: 'Monitor client is closed.',
  cancelled: 'Monitor request was cancelled.',
  request_timeout: 'Monitor request timed out.',
  tls_failed: 'Monitor identity verification failed.',
  transport_failed: 'Monitor connection failed.',
  invalid_request: 'Monitor rejected the gateway request.',
  invalid_response: 'Monitor returned an invalid response.',
  auth_failed: 'Monitor authentication failed.',
  invalid_state: 'Monitor state does not permit this operation.',
  rate_limited: 'Monitor request rate exceeded.',
  unavailable: 'Monitor is not available.',
};

export class MonitorClientError extends Error {
  constructor(readonly code: MonitorClientErrorCode) {
    super(errorMessages[code]);
    this.name = 'MonitorClientError';
  }
}

export interface MonitorClientOptions {
  host: string;
  port?: number;
  certificate: Buffer | string;
  secret: string;
  requestTimeoutMs?: number;
}

interface ResponseValue {
  status: number;
  value: unknown;
}

const defaultRequestTimeoutMs = 7_000;
const maximumRequestTimeoutMs = 30_000;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const retryable = new Set<MonitorClientErrorCode>(['request_timeout', 'transport_failed']);
const tlsErrorCodes = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EPROTO',
  'ERR_MONITOR_CERT_PIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
const validGatewayMessage = ajv.addSchema(publicSchema).getSchema(`${publicSchema.$id}#/$defs/GatewayServerMessage`)!;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicPayload(value: unknown): value is MonitorPayload {
  if (!validGatewayMessage(value) || !record(value)) return false;
  if (value.type === 'metrics') return true;
  return value.type === 'timeline' && record(value.event) && value.event.kind === 'monitor';
}

function metric(value: unknown): value is MonitorMetricFrame {
  return publicPayload(value) && value.type === 'metrics';
}

function remoteError(status: number, value: unknown): MonitorClientError {
  const code = monitorControlClientError(status, value);
  return new MonitorClientError(code ?? 'invalid_response');
}

function pinError(): Error {
  const error = new Error('Monitor certificate pin mismatch') as Error & { code: string };
  error.code = 'ERR_MONITOR_CERT_PIN';
  return error;
}

function mapError(error: unknown, signal?: AbortSignal): MonitorClientError {
  if (error instanceof MonitorClientError) return error;
  if (record(error) && error.cause instanceof MonitorClientError) return error.cause;
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new MonitorClientError('cancelled');
  }
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (tlsErrorCodes.has(code) || code.startsWith('ERR_SSL_')) return new MonitorClientError('tls_failed');
  return new MonitorClientError('transport_failed');
}

async function readResponse(response: IncomingMessage): Promise<unknown> {
  try {
    const contentType = response.headers['content-type'];
    if (typeof contentType !== 'string') throw new MonitorClientError('invalid_response');
    let mediaType: MIMEType;
    try {
      mediaType = new MIMEType(contentType);
    } catch {
      throw new MonitorClientError('invalid_response');
    }
    const charset = mediaType.params.get('charset');
    if (mediaType.essence !== 'application/json' || (charset !== null && charset.toLowerCase() !== 'utf-8'))
      throw new MonitorClientError('invalid_response');
    const length = response.headers['content-length'];
    if (
      length !== undefined &&
      (!/^[0-9]+$/.test(length) || Number(length) > monitorControlSchema.maximumResponseBytes)
    ) {
      throw new MonitorClientError('invalid_response');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > monitorControlSchema.maximumResponseBytes) throw new MonitorClientError('invalid_response');
      chunks.push(chunk);
    }
    if (bytes === 0) throw new MonitorClientError('invalid_response');
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new MonitorClientError('invalid_response');
    }
  } catch (error) {
    response.destroy();
    throw error;
  }
}

export class MonitorClient {
  private readonly host: string;
  private readonly port: number;
  private readonly secret: string;
  private readonly requestTimeoutMs: number;
  private readonly agent: Agent;
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(options: MonitorClientOptions) {
    const port = options.port ?? 9443;
    const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    const certificate = Buffer.from(options.certificate);
    if (
      isIP(options.host) === 0 ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      !secretPattern.test(options.secret) ||
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 100 ||
      requestTimeoutMs > maximumRequestTimeoutMs ||
      certificate.byteLength === 0 ||
      certificate.byteLength > 32_768
    ) {
      throw new MonitorClientError('invalid_config');
    }
    let expected: Buffer;
    try {
      expected = new X509Certificate(certificate).raw;
    } catch {
      throw new MonitorClientError('invalid_config');
    }
    this.host = options.host;
    this.port = port;
    this.secret = options.secret;
    this.requestTimeoutMs = requestTimeoutMs;
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 2,
      maxFreeSockets: 1,
      ca: certificate,
      minVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname: string, peer: PeerCertificate) => {
        if (!peer.raw || peer.raw.byteLength !== expected.byteLength || !timingSafeEqual(peer.raw, expected))
          return pinError();
        return undefined;
      },
    });
  }

  async health(signal?: AbortSignal): Promise<MonitorHealth> {
    const route = monitorControlSchema.routes.health;
    const response = await this.call(route.path, route.method, undefined, signal);
    if (
      (response.status !== route.readyStatus && response.status !== route.unavailableStatus) ||
      !isMonitorControlHealthResponse(response.value) ||
      (response.status === route.readyStatus) !== (response.value.status === 'ready')
    ) {
      if (response.status !== route.readyStatus && response.status !== route.unavailableStatus) {
        throw remoteError(response.status, response.value);
      }
      throw new MonitorClientError('invalid_response');
    }
    return response.value.status;
  }

  async start(signal?: AbortSignal): Promise<{ startedAt: string }> {
    const route = monitorControlSchema.routes.start;
    const response = await this.call(route.path, route.method, undefined, signal);
    if (response.status !== route.successStatus) throw remoteError(response.status, response.value);
    if (!isMonitorControlStartResponse(response.value)) throw new MonitorClientError('invalid_response');
    return response.value;
  }

  async read(after: number, expectedSource?: string, signal?: AbortSignal): Promise<MonitorFramePage> {
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      after > monitorControlSchema.maximumCursor ||
      (expectedSource !== undefined && !isMonitorControlSource(expectedSource))
    ) {
      throw new MonitorClientError('invalid_config');
    }
    const route = monitorControlSchema.routes.frames;
    const response = await this.call(
      `${route.path}?${route.cursorParameter}=${after}`,
      route.method,
      undefined,
      signal,
    );
    if (response.status !== route.successStatus) throw remoteError(response.status, response.value);
    if (!isMonitorControlFramePage(response.value, after, publicPayload, expectedSource)) {
      throw new MonitorClientError('invalid_response');
    }
    return response.value;
  }

  async seal(cutoffAt: string, signal?: AbortSignal): Promise<MonitorSealResult> {
    if (!isMonitorControlTimestamp(cutoffAt)) throw new MonitorClientError('invalid_config');
    const request = { cutoffAt } satisfies MonitorControlSealRequest;
    const body = Buffer.from(JSON.stringify(request));
    const route = monitorControlSchema.routes.seal;
    const response = await this.call(route.path, route.method, body, signal);
    if (response.status !== route.successStatus) throw remoteError(response.status, response.value);
    if (!isMonitorControlSealResponse(response.value, cutoffAt, metric)) {
      throw new MonitorClientError('invalid_response');
    }
    return response.value;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new MonitorClientError('closed'));
    this.agent.destroy();
  }

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body: Buffer | undefined,
    signal?: AbortSignal,
  ): Promise<ResponseValue> {
    if (this.closed) throw new MonitorClientError('closed');
    if (signal?.aborted) throw new MonitorClientError('cancelled');
    let failure: MonitorClientError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.attempt(path, method, body, signal);
      } catch (error) {
        failure = mapError(error, signal);
        if (this.closed) throw new MonitorClientError('closed');
        if (attempt === 1 || !retryable.has(failure.code) || signal?.aborted) throw failure;
      }
    }
    throw failure ?? new MonitorClientError('transport_failed');
  }

  private attempt(
    path: string,
    method: 'GET' | 'POST',
    body: Buffer | undefined,
    signal?: AbortSignal,
  ): Promise<ResponseValue> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const controller = new AbortController();
      const timeoutError = new MonitorClientError('request_timeout');
      const timeout = setTimeout(() => controller.abort(timeoutError), this.requestTimeoutMs);
      const cancelled = () => controller.abort(new MonitorClientError('cancelled'));
      const closed = () => controller.abort(new MonitorClientError('closed'));
      signal?.addEventListener('abort', cancelled, { once: true });
      this.lifetime.signal.addEventListener('abort', closed, { once: true });
      const finish = (error?: unknown, value?: ResponseValue) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancelled);
        this.lifetime.signal.removeEventListener('abort', closed);
        if (error !== undefined) reject(error);
        else resolve(value!);
      };
      if (signal?.aborted) {
        finish(new MonitorClientError('cancelled'));
        return;
      }
      if (this.lifetime.signal.aborted) {
        finish(new MonitorClientError('closed'));
        return;
      }
      const options: RequestOptions = {
        host: this.host,
        port: this.port,
        path,
        method,
        agent: this.agent,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.secret}`,
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(body.byteLength),
              }),
        },
      };
      let outgoing;
      try {
        outgoing = request(options, (response) => {
          void readResponse(response).then(
            (value) =>
              finish(undefined, {
                status: response.statusCode ?? 0,
                value,
              }),
            finish,
          );
        });
      } catch (error) {
        finish(error);
        return;
      }
      outgoing.once('error', finish);
      outgoing.end(body);
    });
  }
}
