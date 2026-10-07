import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import { validUuid } from '../start-session/validation.js';

const RESPONSE_MARGIN_MS = 1000;

export interface ExpiryEvent {
  sessionId: string;
}

export interface ExpiryLog {
  operation: 'expire_provisioning';
  sessionId: string;
  result: string;
  durationMs: number;
}

interface Dependencies {
  expire: (sessionId: string, abortSignal?: AbortSignal) => Promise<'cleaned' | 'ignored' | 'pending'>;
  log?: (entry: ExpiryLog) => void;
}

export function createExpiryHandler({ expire, log = () => {} }: Dependencies) {
  return async (event: ExpiryEvent, context: Pick<Context, 'getRemainingTimeInMillis'>): Promise<void> => {
    const started = performance.now();
    const sessionId = event?.sessionId;
    let result = 'failed';
    try {
      if (!validUuid(sessionId)) throw new Error('Invalid provisioning expiry event');
      const workTimeMs = context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;
      const abortSignal = workTimeMs > 0 ? AbortSignal.timeout(workTimeMs) : AbortSignal.abort();
      result = await expire(sessionId, abortSignal);
    } finally {
      try {
        log({
          operation: 'expire_provisioning',
          sessionId: validUuid(sessionId) ? sessionId : 'invalid',
          result,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        /* Logging must not change cleanup results. */
      }
    }
  };
}
