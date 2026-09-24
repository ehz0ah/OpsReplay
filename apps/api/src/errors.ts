import type { Error as PublicError } from '@opsreplay/contracts';

export class ApiError extends Error {
  constructor(
    readonly code: PublicError['code'],
    message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const statusFor: Record<PublicError['code'], number> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  ACTION_UNAVAILABLE: 422,
  PREREQUISITE_FAILED: 422,
  SESSION_TERMINAL: 422,
  REPLAY_UNAVAILABLE: 422,
  LIMIT_EXCEEDED: 429,
  PROVIDER_FAILED: 502,
  INTERNAL_ERROR: 500,
};
