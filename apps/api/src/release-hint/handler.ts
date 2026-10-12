import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { validMutationRequest, validOwner, validUuid } from '../start-session/validation.js';
import { HintReleaseError, type DynamoHintStore, type HintReleaseErrorCode } from './store.js';

const errors: Record<HintReleaseErrorCode | 'UNAUTHENTICATED', readonly [number, string]> = {
  INVALID_REQUEST: [400, 'Invalid hint request.'],
  UNAUTHENTICATED: [401, 'Sign in before requesting a hint.'],
  NOT_FOUND: [404, 'Session not found.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request ID was already used for a different request.'],
  SESSION_NOT_READY: [409, 'The session is not ready.'],
  SESSION_TERMINAL: [409, 'The session has ended.'],
  HINT_NOT_AVAILABLE: [409, 'The next hint is not available yet.'],
  NO_HINTS_REMAINING: [422, 'No authored hints remain.'],
  INTERNAL_ERROR: [500, 'The hint could not be released. Retry with the same request ID.'],
};

class RequestError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(code);
  }
}

const response = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  body: JSON.stringify(body),
});

function request(event: APIGatewayProxyEvent): { requestId: string } {
  if (typeof event.body !== 'string' || event.body.length > 12_000) throw new RequestError('INVALID_REQUEST');
  try {
    if (event.isBase64Encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body))
      throw new Error();
    const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    if (Buffer.byteLength(body) > 8192) throw new Error();
    const value: unknown = JSON.parse(body);
    if (!validMutationRequest(value)) throw new Error();
    return { requestId: value.requestId.toLowerCase() };
  } catch {
    throw new RequestError('INVALID_REQUEST');
  }
}

export function createReleaseHintHandler({
  store,
  now = () => new Date(),
  log = () => {},
}: {
  store: Pick<DynamoHintStore, 'release'>;
  now?: () => Date;
  log?: (entry: { operation: 'release_hint'; requestId: string; result: string; durationMs: number }) => void;
}) {
  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  ): Promise<APIGatewayProxyResult> => {
    const started = performance.now();
    let requestId = validUuid(context.awsRequestId) ? context.awsRequestId.toLowerCase() : randomUUID();
    let result = 'INTERNAL_ERROR';
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new RequestError('UNAUTHENTICATED');
      const id: unknown = event.pathParameters?.id;
      if (event.httpMethod !== 'POST' || event.resource !== '/v1/sessions/{id}/hints' || !validUuid(id))
        throw new RequestError('INVALID_REQUEST');
      const parsed = request(event);
      requestId = parsed.requestId;
      const available = context.getRemainingTimeInMillis() - 1000;
      const signal = available > 0 ? AbortSignal.timeout(available) : AbortSignal.abort();
      const released = await store.release(id.toLowerCase(), owner, requestId, now().toISOString(), signal);
      result = released.replayed ? 'replayed' : 'released';
      return response(200, released);
    } catch (error) {
      const failure =
        error instanceof RequestError
          ? error
          : error instanceof HintReleaseError
            ? error
            : new HintReleaseError('INTERNAL_ERROR');
      result = failure.code;
      const [statusCode, message] = errors[failure.code];
      return response(statusCode, {
        code: failure.code,
        message,
        requestId,
        ...(failure instanceof HintReleaseError && failure.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: failure.retryAfterSeconds }
          : {}),
      });
    } finally {
      try {
        log({ operation: 'release_hint', requestId, result, durationMs: Math.round(performance.now() - started) });
      } catch {
        /* Reporting cannot change the result. */
      }
    }
  };
}
