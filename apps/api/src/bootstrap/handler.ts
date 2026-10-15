import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { validOwner } from '../start-session/validation.js';

export class BootstrapError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'UNAUTHENTICATED') {
    super(code);
  }
}
export function bootstrapHandler(
  operation: 'get_account' | 'list_catalog',
  path: string,
  authenticated: boolean,
  read: (event: APIGatewayProxyEvent, owner: string | undefined, signal: AbortSignal) => Promise<object>,
  log: (value: object) => void = () => {},
) {
  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'getRemainingTimeInMillis'>,
  ): Promise<APIGatewayProxyResult> => {
    const requestId = randomUUID();
    const started = performance.now();
    let result = 'INTERNAL_ERROR';
    const respond = (statusCode: number, body: object) => ({
      statusCode,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify(body),
    });
    try {
      const subject: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (authenticated && !validOwner(subject)) throw new BootstrapError('UNAUTHENTICATED');
      if (event.httpMethod !== 'GET' || event.resource !== path || event.body !== null || event.isBase64Encoded)
        throw new BootstrapError('INVALID_REQUEST');
      const time = context.getRemainingTimeInMillis() - 1000;
      const signal = time > 0 ? AbortSignal.timeout(time) : AbortSignal.abort();
      signal.throwIfAborted();
      const value = await read(event, validOwner(subject) ? subject : undefined, signal);
      signal.throwIfAborted();
      result = 'read';
      return respond(200, value);
    } catch (error) {
      const code = error instanceof BootstrapError ? error.code : 'INTERNAL_ERROR';
      result = code;
      return respond(code === 'INVALID_REQUEST' ? 400 : code === 'UNAUTHENTICATED' ? 401 : 500, {
        code,
        requestId,
        message:
          code === 'INVALID_REQUEST'
            ? 'Invalid request. Restart paging if the catalogue changed.'
            : code === 'UNAUTHENTICATED'
              ? 'Sign in to continue.'
              : 'The request could not be completed. Try again.',
      });
    } finally {
      try {
        log({ operation, requestId, result, durationMs: Math.round(performance.now() - started) });
      } catch {
        /* Logging cannot change responses. */
      }
    }
  };
}
