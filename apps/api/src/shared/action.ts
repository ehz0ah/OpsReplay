import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { validOwner } from '../start-session/validation.js';
const failures = {
  INVALID_REQUEST: [400, 'Invalid request.'],
  INVALID_CURSOR: [400, 'Restart paging with a new cursor.'],
  UNAUTHENTICATED: [401, 'Sign in to continue.'],
  NOT_FOUND: [404, 'Requested item not found.'],
  PLAN_REQUIRED: [403, 'This exercise requires Pro access.'],
  VERSION_UNAVAILABLE: [422, 'This exercise version is unavailable.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request ID belongs to a different request.'],
  CONFLICT: [409, 'The state changed. Retry the same request.'],
  INTERNAL_ERROR: [500, 'The request could not be completed. Try again.'],
} as const;
export class ActionError extends Error {
  constructor(readonly code: keyof typeof failures) {
    super(code);
  }
}
export function actionHandler(
  method: 'GET' | 'POST',
  resource: string,
  operation: (event: APIGatewayProxyEvent, owner: string, signal: AbortSignal) => Promise<unknown>,
) {
  return async (event: APIGatewayProxyEvent, context: Pick<Context, 'getRemainingTimeInMillis'>) => {
    let requestId = randomUUID();
    if (method === 'POST' && event.body && Buffer.byteLength(event.body) <= 128 * 1024) {
      try {
        const body = JSON.parse(event.body);
        if (
          typeof body.requestId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)
        )
          requestId = body.requestId;
      } catch {
        /* Invalid bodies are rejected below. */
      }
    }
    const reply = (statusCode: number, body: unknown) => ({
      statusCode,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      body: JSON.stringify(body),
    });
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new ActionError('UNAUTHENTICATED');
      if (
        event.httpMethod !== method ||
        event.resource !== resource ||
        event.isBase64Encoded ||
        (method === 'GET' && event.body !== null)
      )
        throw new ActionError('INVALID_REQUEST');
      const time = context.getRemainingTimeInMillis() - 1000;
      const signal = time > 0 ? AbortSignal.timeout(time) : AbortSignal.abort();
      signal.throwIfAborted();
      const value = await operation(event, owner, signal);
      signal.throwIfAborted();
      return reply(200, value);
    } catch (error) {
      const code = error instanceof ActionError ? error.code : 'INTERNAL_ERROR';
      const [status, message] = failures[code];
      return reply(status, { code, message, requestId });
    }
  };
}
export function contentId(event: APIGatewayProxyEvent) {
  const id = event.pathParameters?.id;
  if (!id || id.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new ActionError('INVALID_REQUEST');
  return id;
}
export function noQuery(event: APIGatewayProxyEvent) {
  if (Object.keys(event.multiValueQueryStringParameters ?? event.queryStringParameters ?? {}).length)
    throw new ActionError('INVALID_REQUEST');
}
