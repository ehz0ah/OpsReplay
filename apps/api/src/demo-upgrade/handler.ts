import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { validMutationRequest, validOwner } from '../start-session/validation.js';
import { demoUpgradeDeadline, type DemoUpgradePolicy } from './policy.js';
import { DemoUpgradeConflict, DemoUpgradeUnavailable, type DemoUpgradeResult } from './store.js';

interface Store {
  activate(
    owner: string,
    requestId: string,
    expiresAt: string,
    now: () => number,
    signal: AbortSignal,
  ): Promise<DemoUpgradeResult>;
}
class RequestError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'DEMO_UNAVAILABLE') {
    super(code);
  }
}

export function createDemoUpgradeHandler(
  store: Store,
  policy?: DemoUpgradePolicy,
  now = Date.now,
  log: (value: object) => void = () => {},
) {
  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'getRemainingTimeInMillis'>,
  ): Promise<APIGatewayProxyResult> => {
    let requestId: string = randomUUID();
    const started = performance.now();
    let result = 'INTERNAL_ERROR';
    const respond = (statusCode: number, body: object) => ({
      statusCode,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: JSON.stringify(body),
    });
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!validOwner(owner)) throw new RequestError('UNAUTHENTICATED');
      if (
        event.httpMethod !== 'POST' ||
        event.resource !== '/v1/demo-upgrade' ||
        event.isBase64Encoded ||
        Object.keys(event.multiValueQueryStringParameters ?? event.queryStringParameters ?? {}).length ||
        typeof event.body !== 'string' ||
        Buffer.byteLength(event.body, 'utf8') > 256
      )
        throw new RequestError('INVALID_REQUEST');
      let body: unknown;
      try {
        body = JSON.parse(event.body);
      } catch {
        throw new RequestError('INVALID_REQUEST');
      }
      if (!validMutationRequest(body)) throw new RequestError('INVALID_REQUEST');
      requestId = body.requestId;
      const deadline = demoUpgradeDeadline(policy, owner, now());
      if (!deadline) throw new RequestError('DEMO_UNAVAILABLE');
      const remaining = context.getRemainingTimeInMillis() - 1000;
      const signal = remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
      signal.throwIfAborted();
      const value = await store.activate(owner, requestId, deadline, now, signal);
      signal.throwIfAborted();
      result = value.changed ? 'activated' : 'unchanged';
      return respond(200, value);
    } catch (error) {
      const code =
        error instanceof RequestError
          ? error.code === 'DEMO_UNAVAILABLE'
            ? 'ACCESS_DENIED'
            : error.code
          : error instanceof DemoUpgradeUnavailable
            ? 'ACCESS_DENIED'
            : error instanceof DemoUpgradeConflict
              ? 'IDEMPOTENCY_CONFLICT'
              : 'INTERNAL_ERROR';
      result = code;
      const status =
        code === 'INVALID_REQUEST'
          ? 400
          : code === 'UNAUTHENTICATED'
            ? 401
            : code === 'ACCESS_DENIED'
              ? 403
              : code === 'IDEMPOTENCY_CONFLICT'
                ? 409
                : 500;
      return respond(status, {
        code,
        requestId,
        message:
          code === 'UNAUTHENTICATED'
            ? 'Sign in to continue.'
            : code === 'ACCESS_DENIED'
              ? 'Demo upgrades are not available for this account or presentation window.'
              : code === 'INVALID_REQUEST'
                ? 'Invalid demo upgrade request.'
                : 'Read your current plan before retrying the same demo upgrade request.',
      });
    } finally {
      try {
        log({ operation: 'demo_upgrade', requestId, result, durationMs: Math.round(performance.now() - started) });
      } catch {
        /* Logging cannot change responses. */
      }
    }
  };
}
