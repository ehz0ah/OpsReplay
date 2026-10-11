import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { AttemptStoreError, type DynamoAttemptStore } from '../../../../packages/session/src/attempt-store.js';
import { validOwner, validUuid } from '../start-session/validation.js';
import { publicView } from '../shared/session-view.js';
import type { SessionView } from '../start-session/types.js';

const errors = {
  INVALID_REQUEST: [400, 'Invalid session end request.'],
  UNAUTHENTICATED: [401, 'Sign in before ending a session.'],
  NOT_FOUND: [404, 'Session not found.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request ID was already used for a different request.'],
  INTERNAL_ERROR: [500, 'The session could not be ended. Retry with the same request ID.'],
} as const;
class RequestError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(code);
  }
}
const response = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});
export function createEndSessionHandler({
  store,
  now = () => new Date(),
  log = () => {},
}: {
  store: Pick<DynamoAttemptStore, 'outcome'>;
  now?: () => Date;
  log?: (entry: { operation: 'end_session'; requestId: string; result: string; durationMs: number }) => void;
}) {
  return async (event: APIGatewayProxyEvent, context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>) => {
    const started = performance.now();
    let requestId = validUuid(context.awsRequestId) ? context.awsRequestId : randomUUID();
    let result = 'INTERNAL_ERROR';
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new RequestError('UNAUTHENTICATED');
      const id: unknown = event.pathParameters?.id;
      if (
        event.httpMethod !== 'POST' ||
        event.resource !== '/v1/sessions/{id}/end' ||
        !validUuid(id) ||
        typeof event.body !== 'string' ||
        Buffer.byteLength(event.body) > 8192
      )
        throw new RequestError('INVALID_REQUEST');
      let value: unknown;
      try {
        if (
          event.isBase64Encoded &&
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.body)
        )
          throw new Error();
        value = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch {
        throw new RequestError('INVALID_REQUEST');
      }
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !('requestId' in value) ||
        !validUuid(value.requestId)
      )
        throw new RequestError('INVALID_REQUEST');
      requestId = value.requestId.toLowerCase();
      const available = context.getRemainingTimeInMillis() - 1000;
      const signal = available > 0 ? AbortSignal.timeout(available) : AbortSignal.abort();
      signal.throwIfAborted();
      const at = now().toISOString();
      const session = await store.outcome(
        id.toLowerCase(),
        'ended',
        'learner_ended',
        at,
        signal,
        owner,
        undefined,
        at,
        requestId,
      );
      result = 'ended';
      return response(200, { session: publicView(session.view as SessionView) });
    } catch (error) {
      const code =
        error instanceof RequestError
          ? error.code
          : error instanceof AttemptStoreError && error.code === 'not_found'
            ? 'NOT_FOUND'
            : error instanceof AttemptStoreError && error.code === 'conflict'
              ? 'IDEMPOTENCY_CONFLICT'
              : 'INTERNAL_ERROR';
      result = code;
      const [statusCode, message] = errors[code];
      return response(statusCode, { code, message, requestId });
    } finally {
      try {
        log({ operation: 'end_session', requestId, result, durationMs: Math.round(performance.now() - started) });
      } catch {
        /* Reporting cannot change the result. */
      }
    }
  };
}
