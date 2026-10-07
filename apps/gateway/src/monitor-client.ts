import { X509Certificate, timingSafeEqual } from 'node:crypto';
import { Agent, request } from 'node:https';
import type { IncomingMessage, RequestOptions } from 'node:http';
import { isIP } from 'node:net';
import type { PeerCertificate } from 'node:tls';
import { MIMEType } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../../packages/contracts/schemas/public.schema.json';

export type MonitorHealth = 'starting' | 'ready' | 'failed';
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
export interface MonitorFrame {
  source: string;
  sequence: number;
  recordedAt: string;
  payload: MonitorPayload;
}
export interface MonitorFramePage {
  frames: MonitorFrame[];
  nextSequence: number;
  sealed: boolean;
}
export interface MonitorSealResult {
  cutoffAt: string;
  final: MonitorMetricFrame;
}

export type MonitorClientErrorCode = 'invalid_config' | 'closed' | 'cancelled'
  | 'request_timeout' | 'tls_failed' | 'transport_failed' | 'invalid_request' | 'invalid_response'
  | 'auth_failed' | 'invalid_state' | 'rate_limited' | 'unavailable';

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

interface ResponseValue { status: number; value: unknown }

const responseBytes = 65_536;
const maximumCursor = 999_999;
const defaultRequestTimeoutMs = 7_000;
const maximumRequestTimeoutMs = 30_000;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const sourcePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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
const remoteErrors = {
  AUTH_FAILED: { status: 401, code: 'auth_failed' },
  INVALID_REQUEST: { status: 400, code: 'invalid_request' },
  INVALID_STATE: { status: 409, code: 'invalid_state' },
  RATE_LIMITED: { status: 429, code: 'rate_limited' },
  UNAVAILABLE: { status: 503, code: 'unavailable' },
  INTERNAL_ERROR: { status: 500, code: 'unavailable' },
} as const satisfies Record<string, { status: number; code: MonitorClientErrorCode }>;

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
const validGatewayMessage = ajv.addSchema(publicSchema)
  .getSchema(`${publicSchema.$id}#/$defs/GatewayServerMessage`)!;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !canonicalTimestamp.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function publicPayload(value: unknown): value is MonitorPayload {
  if (!validGatewayMessage(value) || !record(value)) return false;
  if (value.type === 'metrics') return true;
  return value.type === 'timeline' && record(value.event) && value.event.kind === 'monitor';
}

function metric(value: unknown): value is MonitorMetricFrame {
  return publicPayload(value) && value.type === 'metrics';
}

function health(value: unknown): value is { status: MonitorHealth } {
  return record(value) && exact(value, ['status'])
    && (value.status === 'starting' || value.status === 'ready' || value.status === 'failed');
}

function started(value: unknown): value is { startedAt: string } {
  return record(value) && exact(value, ['startedAt']) && timestamp(value.startedAt);
}

function frame(value: unknown): value is MonitorFrame {
  return record(value) && exact(value, ['source', 'sequence', 'recordedAt', 'payload'])
    && typeof value.source === 'string' && sourcePattern.test(value.source)
    && Number.isInteger(value.sequence) && (value.sequence as number) >= 1
    && (value.sequence as number) <= maximumCursor && timestamp(value.recordedAt)
    && publicPayload(value.payload);
}

function page(value: unknown, after: number, expectedSource?: string): value is MonitorFramePage {
  if (!record(value) || !exact(value, ['frames', 'nextSequence', 'sealed'])
    || !Array.isArray(value.frames) || value.frames.length > 100
    || !Number.isInteger(value.nextSequence) || (value.nextSequence as number) < after
    || (value.nextSequence as number) > maximumCursor || typeof value.sealed !== 'boolean') return false;
  let sequence = after;
  let source = expectedSource;
  for (const valueFrame of value.frames) {
    if (!frame(valueFrame) || valueFrame.sequence !== sequence + 1
      || (source !== undefined && valueFrame.source !== source)) return false;
    source ??= valueFrame.source;
    sequence = valueFrame.sequence;
  }
  return value.nextSequence === sequence;
}

function sealed(value: unknown, cutoffAt: string): value is MonitorSealResult {
  return record(value) && exact(value, ['cutoffAt', 'final'])
    && value.cutoffAt === cutoffAt && metric(value.final);
}

function remoteError(status: number, value: unknown): MonitorClientError {
  if (!record(value) || !exact(value, ['code', 'message'])
    || typeof value.code !== 'string' || typeof value.message !== 'string'
    || value.message.length === 0 || value.message.length > 1_000) return new MonitorClientError('invalid_response');
  const detail = remoteErrors[value.code as keyof typeof remoteErrors];
  if (!detail || detail.status !== status) return new MonitorClientError('invalid_response');
  return new MonitorClientError(detail.code);
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
    try { mediaType = new MIMEType(contentType); }
    catch { throw new MonitorClientError('invalid_response'); }
    const charset = mediaType.params.get('charset');
    if (mediaType.essence !== 'application/json'
      || (charset !== null && charset.toLowerCase() !== 'utf-8')) throw new MonitorClientError('invalid_response');
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > responseBytes)) {
      throw new MonitorClientError('invalid_response');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > responseBytes) throw new MonitorClientError('invalid_response');
      chunks.push(chunk);
    }
    if (bytes === 0) throw new MonitorClientError('invalid_response');
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new MonitorClientError('invalid_response'); }
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
    if (isIP(options.host) === 0 || !Number.isInteger(port) || port < 1 || port > 65_535
      || !secretPattern.test(options.secret) || !Number.isInteger(requestTimeoutMs)
      || requestTimeoutMs < 100 || requestTimeoutMs > maximumRequestTimeoutMs
      || certificate.byteLength === 0 || certificate.byteLength > 32_768) {
      throw new MonitorClientError('invalid_config');
    }
    let expected: Buffer;
    try { expected = new X509Certificate(certificate).raw; }
    catch { throw new MonitorClientError('invalid_config'); }
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
        if (!peer.raw || peer.raw.byteLength !== expected.byteLength
          || !timingSafeEqual(peer.raw, expected)) return pinError();
        return undefined;
      },
    });
  }

  async health(signal?: AbortSignal): Promise<MonitorHealth> {
    const response = await this.call('/healthz', 'GET', undefined, signal);
    if ((response.status !== 200 && response.status !== 503) || !health(response.value)
      || (response.status === 200) !== (response.value.status === 'ready')) {
      if (response.status !== 200 && response.status !== 503) throw remoteError(response.status, response.value);
      throw new MonitorClientError('invalid_response');
    }
    return response.value.status;
  }

  async start(signal?: AbortSignal): Promise<{ startedAt: string }> {
    const response = await this.call('/v1/start', 'POST', undefined, signal);
    if (response.status !== 200) throw remoteError(response.status, response.value);
    if (!started(response.value)) throw new MonitorClientError('invalid_response');
    return response.value;
  }

  async read(after: number, expectedSource?: string, signal?: AbortSignal): Promise<MonitorFramePage> {
    if (!Number.isInteger(after) || after < 0 || after > maximumCursor
      || (expectedSource !== undefined && !sourcePattern.test(expectedSource))) {
      throw new MonitorClientError('invalid_config');
    }
    const response = await this.call(`/v1/frames?after=${after}`, 'GET', undefined, signal);
    if (response.status !== 200) throw remoteError(response.status, response.value);
    if (!page(response.value, after, expectedSource)) throw new MonitorClientError('invalid_response');
    return response.value;
  }

  async seal(cutoffAt: string, signal?: AbortSignal): Promise<MonitorSealResult> {
    if (!timestamp(cutoffAt)) throw new MonitorClientError('invalid_config');
    const body = Buffer.from(JSON.stringify({ cutoffAt }));
    const response = await this.call('/v1/seal', 'POST', body, signal);
    if (response.status !== 200) throw remoteError(response.status, response.value);
    if (!sealed(response.value, cutoffAt)) throw new MonitorClientError('invalid_response');
    return response.value;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort(new MonitorClientError('closed'));
    this.agent.destroy();
  }

  private async call(path: string, method: 'GET' | 'POST', body: Buffer | undefined,
    signal?: AbortSignal): Promise<ResponseValue> {
    if (this.closed) throw new MonitorClientError('closed');
    if (signal?.aborted) throw new MonitorClientError('cancelled');
    let failure: MonitorClientError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.attempt(path, method, body, signal); }
      catch (error) {
        failure = mapError(error, signal);
        if (this.closed) throw new MonitorClientError('closed');
        if (attempt === 1 || !retryable.has(failure.code) || signal?.aborted) throw failure;
      }
    }
    throw failure ?? new MonitorClientError('transport_failed');
  }

  private attempt(path: string, method: 'GET' | 'POST', body: Buffer | undefined,
    signal?: AbortSignal): Promise<ResponseValue> {
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
          ...(body === undefined ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': String(body.byteLength),
          }),
        },
      };
      let outgoing;
      try {
        outgoing = request(options, response => {
          void readResponse(response).then(value => finish(undefined, {
            status: response.statusCode ?? 0,
            value,
          }), finish);
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
