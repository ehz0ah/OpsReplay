import type { ActionResponse, SessionResponse } from '@opsreplay/contracts';
import { read, RequestError, sessionPath } from './client.js';
import type { PendingRequest } from './journal.js';

export function deliver(
  ownerId: string,
  value: PendingRequest,
): Promise<ActionResponse | SessionResponse> {
  switch (value.kind) {
    case 'start':
      return read('SessionResponse', '/v1/sessions', value.body, ownerId);
    case 'action':
      return read('ActionResponse', sessionPath(value.sessionId) + '/actions', value.body, ownerId);
    case 'end':
      return read('SessionResponse', sessionPath(value.sessionId) + '/end', value.body, ownerId);
    case 'replay':
      return read(
        'SessionResponse',
        sessionPath(value.sessionId) + '/replays',
        value.body,
        ownerId,
      );
  }
}

export function isDefinitiveRejection(error: unknown): error is RequestError {
  return (
    error instanceof RequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.code !== 'UNAUTHENTICATED' &&
    error.code !== 'INVALID_RESPONSE' &&
    error.code !== 'NETWORK_ERROR'
  );
}
