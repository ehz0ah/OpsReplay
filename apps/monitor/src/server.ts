import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:https';
import { MIMEType } from 'node:util';
import { parseCutoffAt } from './control.js';
import type { MonitorControl } from './control.js';
import { MonitorError, limits } from './types.js';

export interface ControlServerOptions {
  key: Buffer | string;
  cert: Buffer | string;
  secret: string;
  now?: () => number;
}

interface Window { second: number; count: number }
const errorBodies = {
  AUTH_FAILED: { status: 401, message: 'Monitor authentication failed.' },
  INVALID_REQUEST: { status: 400, message: 'Invalid monitor request.' },
  INVALID_STATE: { status: 409, message: 'Monitor state does not permit this operation.' },
  RATE_LIMITED: { status: 429, message: 'Monitor request rate exceeded.' },
  UNAVAILABLE: { status: 503, message: 'Monitor is not available.' },
  INTERNAL_ERROR: { status: 500, message: 'Monitor operation failed.' },
} as const;
type ErrorCode = keyof typeof errorBodies;

class ControlRequestError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

function send(response: ServerResponse, status: number, value: object): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > limits.bodyBytes) throw new ControlRequestError('INTERNAL_ERROR');
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  try {
    if (typeof contentType !== 'string') throw new Error('missing content type');
    const mediaType = new MIMEType(contentType);
    const charset = mediaType.params.get('charset');
    if (mediaType.essence !== 'application/json'
      || (charset !== null && charset.toLowerCase() !== 'utf-8')) throw new Error('invalid content type');
  } catch { throw new ControlRequestError('INVALID_REQUEST'); }
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > limits.controlBodyBytes)) {
    throw new ControlRequestError('INVALID_REQUEST');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > limits.controlBodyBytes) throw new ControlRequestError('INVALID_REQUEST');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new ControlRequestError('INVALID_REQUEST');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ControlRequestError('INVALID_REQUEST'); }
}

function requireEmptyBody(request: IncomingMessage): void {
  if ((request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')
    || request.headers['transfer-encoding'] !== undefined) throw new ControlRequestError('INVALID_REQUEST');
}

function cutoff(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || typeof (value as { cutoffAt?: unknown }).cutoffAt !== 'string') {
    throw new ControlRequestError('INVALID_REQUEST');
  }
  const result = (value as { cutoffAt: string }).cutoffAt;
  if (result.length > 40) throw new ControlRequestError('INVALID_REQUEST');
  try { parseCutoffAt(result); }
  catch { throw new ControlRequestError('INVALID_REQUEST'); }
  return result;
}

function cursor(url: URL): number {
  if ([...url.searchParams.keys()].some(key => key !== 'after')) throw new ControlRequestError('INVALID_REQUEST');
  const values = url.searchParams.getAll('after');
  if (values.length !== 1 || !/^(0|[1-9][0-9]{0,5})$/.test(values[0]!)) {
    throw new ControlRequestError('INVALID_REQUEST');
  }
  const raw = values[0]!;
  return Number(raw);
}

export function createControlServer(control: MonitorControl, options: ControlServerOptions): Server {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.secret)) throw new MonitorError('invalid_config');
  const expected = createHash('sha256').update(options.secret).digest();
  const now = options.now ?? Date.now;
  let authenticated: Window = { second: -1, count: 0 };
  let unauthenticated: Window = { second: -1, count: 0 };
  let active = 0;

  const authorise = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return false;
    const supplied = createHash('sha256').update(header.slice(7)).digest();
    return timingSafeEqual(expected, supplied);
  };
  const rate = (valid: boolean): boolean => {
    const second = Math.floor(now() / 1000);
    let window = valid ? authenticated : unauthenticated;
    if (window.second !== second) window = { second, count: 0 };
    window.count++;
    if (valid) authenticated = window;
    else unauthenticated = window;
    return window.count <= (valid ? limits.controlAuthenticatedRps : limits.controlUnauthenticatedRps);
  };

  const server = createServer({ key: options.key, cert: options.cert, minVersion: 'TLSv1.3',
    handshakeTimeout: limits.controlRequestMs, maxHeaderSize: 2048 }, async (request, response) => {
    response.setTimeout(limits.controlRequestMs, () => response.destroy());
    active++;
    try {
      if (active > limits.controlConcurrentRequests) throw new ControlRequestError('RATE_LIMITED');
      const url = new URL(request.url ?? '', 'https://monitor.invalid');
      const valid = authorise(request);
      if (!rate(valid)) throw new ControlRequestError('RATE_LIMITED');
      if (!valid) throw new ControlRequestError('AUTH_FAILED');
      if (url.pathname === '/healthz' && request.method === 'GET' && url.search === '') {
        requireEmptyBody(request);
        const health = control.health();
        send(response, health === 'ready' ? 200 : 503, { status: health });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/start' && url.search === '') {
        requireEmptyBody(request);
        send(response, 200, control.start());
      } else if (request.method === 'GET' && url.pathname === '/v1/frames') {
        requireEmptyBody(request);
        send(response, 200, control.read(cursor(url)));
      } else if (request.method === 'POST' && url.pathname === '/v1/seal' && url.search === '') {
        send(response, 200, await control.seal(cutoff(await body(request))));
      } else {
        throw new ControlRequestError('INVALID_REQUEST');
      }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.shouldKeepAlive = false;
      let code: ErrorCode = 'INTERNAL_ERROR';
      if (error instanceof ControlRequestError) code = error.code;
      else if (error instanceof MonitorError && error.code === 'invalid_boundary') code = 'INVALID_STATE';
      else if (error instanceof MonitorError) code = 'UNAVAILABLE';
      const detail = errorBodies[code];
      send(response, detail.status, { code, message: detail.message });
    } finally { active--; }
  });
  server.maxConnections = limits.controlConnections;
  server.headersTimeout = limits.controlRequestMs;
  server.requestTimeout = limits.controlRequestMs;
  server.keepAliveTimeout = limits.controlRequestMs;
  server.maxHeadersCount = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}
