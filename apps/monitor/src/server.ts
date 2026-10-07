import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:https';
import { MIMEType } from 'node:util';
import type { MonitorControl } from './control.js';
import type { MetricFrame, PublicFrame } from './types.js';
import { MonitorError, limits } from './types.js';
import type {
  MonitorControlErrorCode,
  MonitorControlResponse,
} from '../../../packages/contracts/private/monitor-control.js';
import {
  isMonitorControlSealRequest,
  monitorControlErrorBody,
  monitorControlSchema,
  parseMonitorControlCursor,
} from '../../../packages/contracts/private/monitor-control.js';

export interface ControlServerOptions {
  key: Buffer | string;
  cert: Buffer | string;
  secret: string;
  now?: () => number;
}

interface Window {
  second: number;
  count: number;
}
class ControlRequestError extends Error {
  constructor(readonly code: MonitorControlErrorCode) {
    super(code);
  }
}

function send(response: ServerResponse, status: number, value: MonitorControlResponse<PublicFrame, MetricFrame>): void {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > monitorControlSchema.maximumResponseBytes) throw new ControlRequestError('INTERNAL_ERROR');
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
    if (mediaType.essence !== 'application/json' || (charset !== null && charset.toLowerCase() !== 'utf-8'))
      throw new Error('invalid content type');
  } catch {
    throw new ControlRequestError('INVALID_REQUEST');
  }
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > monitorControlSchema.maximumRequestBytes)) {
    throw new ControlRequestError('INVALID_REQUEST');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > monitorControlSchema.maximumRequestBytes) throw new ControlRequestError('INVALID_REQUEST');
    chunks.push(chunk);
  }
  if (bytes === 0) throw new ControlRequestError('INVALID_REQUEST');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ControlRequestError('INVALID_REQUEST');
  }
}

function requireEmptyBody(request: IncomingMessage): void {
  if (
    (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') ||
    request.headers['transfer-encoding'] !== undefined
  )
    throw new ControlRequestError('INVALID_REQUEST');
}

function cutoff(value: unknown): string {
  if (!isMonitorControlSealRequest(value)) throw new ControlRequestError('INVALID_REQUEST');
  return value.cutoffAt;
}

function cursor(url: URL): number {
  const parameter = monitorControlSchema.routes.frames.cursorParameter;
  if ([...url.searchParams.keys()].some((key) => key !== parameter)) {
    throw new ControlRequestError('INVALID_REQUEST');
  }
  const values = url.searchParams.getAll(parameter);
  if (values.length !== 1) throw new ControlRequestError('INVALID_REQUEST');
  const parsed = parseMonitorControlCursor(values[0]!);
  if (parsed === undefined) throw new ControlRequestError('INVALID_REQUEST');
  return parsed;
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

  const server = createServer(
    {
      key: options.key,
      cert: options.cert,
      minVersion: 'TLSv1.3',
      handshakeTimeout: limits.controlRequestMs,
      maxHeaderSize: 2048,
    },
    async (request, response) => {
      response.setTimeout(limits.controlRequestMs, () => response.destroy());
      active++;
      try {
        if (active > limits.controlConcurrentRequests) throw new ControlRequestError('RATE_LIMITED');
        const url = new URL(request.url ?? '', 'https://monitor.invalid');
        const valid = authorise(request);
        if (!rate(valid)) throw new ControlRequestError('RATE_LIMITED');
        if (!valid) throw new ControlRequestError('AUTH_FAILED');
        const routes = monitorControlSchema.routes;
        if (url.pathname === routes.health.path && request.method === routes.health.method && url.search === '') {
          requireEmptyBody(request);
          const health = control.health();
          send(response, health === 'ready' ? routes.health.readyStatus : routes.health.unavailableStatus, {
            status: health,
          });
          return;
        }
        if (request.method === routes.start.method && url.pathname === routes.start.path && url.search === '') {
          requireEmptyBody(request);
          send(response, routes.start.successStatus, control.start());
        } else if (request.method === routes.frames.method && url.pathname === routes.frames.path) {
          requireEmptyBody(request);
          send(response, routes.frames.successStatus, control.read(cursor(url)));
        } else if (request.method === routes.seal.method && url.pathname === routes.seal.path && url.search === '') {
          send(response, routes.seal.successStatus, await control.seal(cutoff(await body(request))));
        } else {
          throw new ControlRequestError('INVALID_REQUEST');
        }
      } catch (error) {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.shouldKeepAlive = false;
        let code: MonitorControlErrorCode = 'INTERNAL_ERROR';
        if (error instanceof ControlRequestError) code = error.code;
        else if (error instanceof MonitorError && error.code === 'invalid_boundary') code = 'INVALID_STATE';
        else if (error instanceof MonitorError) code = 'UNAVAILABLE';
        const detail = monitorControlSchema.errors[code];
        send(response, detail.status, monitorControlErrorBody(code));
      } finally {
        active--;
      }
    },
  );
  server.maxConnections = limits.controlConnections;
  server.headersTimeout = limits.controlRequestMs;
  server.requestTimeout = limits.controlRequestMs;
  server.keepAliveTimeout = limits.controlRequestMs;
  server.maxHeadersCount = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}
