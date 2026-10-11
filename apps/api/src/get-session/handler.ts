import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { publicView } from '../shared/session-view.js';
import { validOwner, validUuid } from '../start-session/validation.js';
import type { SessionReader } from './store.js';

const RESPONSE_MARGIN_MS = 1000;
const errors = {
  INVALID_REQUEST: [400, 'Invalid session status request.'],
  UNAUTHENTICATED: [401, 'Sign in before reading a session.'],
  NOT_FOUND: [404, 'Session not found.'],
  INTERNAL_ERROR: [500, 'The session could not be read. Try again.'],
} as const;

class RequestError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(code);
  }
}

export interface SessionReadLog {
  operation: 'get_session';
  requestId: string;
  result: string;
  durationMs: number;
}

const response = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export function createGetSessionHandler({
  store,
  log = () => {},
}: {
  store: SessionReader;
  log?: (entry: SessionReadLog) => void;
}) {
  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  ): Promise<APIGatewayProxyResult> => {
    const started = performance.now();
    const requestId = validUuid(context.awsRequestId) ? context.awsRequestId.toLowerCase() : randomUUID();
    let result = 'INTERNAL_ERROR';
    try {
      // Only API Gateway's verified Cognito identity grants access. Headers never do.
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new RequestError('UNAUTHENTICATED');
      const pathId: unknown = event.pathParameters?.id;
      if (
        event.httpMethod !== 'GET' ||
        event.resource !== '/v1/sessions/{id}' ||
        event.body !== null ||
        !validUuid(pathId)
      ) {
        throw new RequestError('INVALID_REQUEST');
      }
      const sessionId = pathId.toLowerCase();
      const workTimeMs = context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;
      const abortSignal = workTimeMs > 0 ? AbortSignal.timeout(workTimeMs) : AbortSignal.abort();
      abortSignal.throwIfAborted();
      const view = await store.read(sessionId, owner, abortSignal);
      abortSignal.throwIfAborted();
      if (view === undefined) throw new RequestError('NOT_FOUND');
      if (view.id !== sessionId) throw new Error('Session identity mismatch');
      const body = publicView(view);
      result = 'read';
      return response(200, body);
    } catch (error) {
      const failure = error instanceof RequestError ? error : new RequestError('INTERNAL_ERROR');
      result = failure.code;
      const [statusCode, message] = errors[failure.code];
      return response(statusCode, { code: failure.code, message, requestId });
    } finally {
      try {
        log({ operation: 'get_session', requestId, result, durationMs: Math.round(performance.now() - started) });
      } catch {
        /* Logging must not change the response. */
      }
    }
  };
}
