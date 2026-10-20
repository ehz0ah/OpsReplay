import type { Context } from 'aws-lambda';
import { DeletionError, type SessionDeletion } from './service.js';
import { isTerminalOwnerId, isTerminalSessionId } from '../../../../packages/contracts/private/terminal-access.js';

/** Invocation is authorised by IAM, not by ownerId in the payload. No API route. */
export function createDeletionHandler(service: Pick<SessionDeletion, 'run'>) {
  return async (event: unknown, context: Pick<Context, 'getRemainingTimeInMillis'>) => {
    if (!event || typeof event !== 'object' || Array.isArray(event))
      return { status: 'rejected', code: 'INVALID_REQUEST' };
    const value = event as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 ||
      value.operation !== 'delete_session' ||
      !isTerminalOwnerId(value.ownerId) ||
      !isTerminalSessionId(value.sessionId)
    )
      return { status: 'rejected', code: 'INVALID_REQUEST' };
    const milliseconds = context.getRemainingTimeInMillis() - 1500;
    const signal = milliseconds > 0 ? AbortSignal.timeout(milliseconds) : AbortSignal.abort();
    try {
      return { status: await service.run(value.ownerId, value.sessionId, signal) };
    } catch (error) {
      // SDK errors can contain identifiers. Do not return or log them.
      return { status: 'rejected', code: error instanceof DeletionError ? error.code : 'RETRY_REQUIRED' };
    }
  };
}
