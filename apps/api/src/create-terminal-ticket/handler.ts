import { randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  isTerminalOwnerId,
  isTerminalTicket,
  isTerminalTimestamp,
  terminalTicketHash,
} from '../../../../packages/contracts/private/terminal-access.js';
import type { TerminalTicket } from '../start-session/types.js';
import { validTerminalTicket, validUuid } from '../start-session/validation.js';
import { terminalTicketLifetimeSeconds, validTerminalGatewayUrl } from './configuration.js';
import type { TerminalTicketIssuer } from './store.js';

const RESPONSE_MARGIN_MS = 1000;
const maximumTicketAttempts = 3;

const errors = {
  INVALID_REQUEST: [400, 'Invalid terminal ticket request.'],
  UNAUTHENTICATED: [401, 'Sign in before connecting to a terminal.'],
  NOT_FOUND: [404, 'Session not found.'],
  SESSION_NOT_READY: [409, 'The terminal is not ready.'],
  SESSION_TERMINAL: [409, 'The session has ended.'],
  INTERNAL_ERROR: [500, 'The terminal ticket could not be issued. Try again.'],
} as const;

class RequestError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(code);
  }
}

export interface TerminalTicketLog {
  operation: 'create_terminal_ticket';
  requestId: string;
  sessionId: string;
  result: string;
  durationMs: number;
}

interface Dependencies {
  store: TerminalTicketIssuer;
  gatewayUrl: string;
  now?: () => Date;
  newTicket?: () => string;
  log?: (entry: TerminalTicketLog) => void;
}

const response = (statusCode: number, body: object): APIGatewayProxyResult => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

export function createTerminalTicketHandler({
  store,
  gatewayUrl,
  now = () => new Date(),
  newTicket = () => randomBytes(32).toString('base64url'),
  log = () => {},
}: Dependencies) {
  if (!validTerminalGatewayUrl(gatewayUrl)) throw new Error('Invalid terminal Gateway URL');

  return async (
    event: APIGatewayProxyEvent,
    context: Pick<Context, 'awsRequestId' | 'getRemainingTimeInMillis'>,
  ): Promise<APIGatewayProxyResult> => {
    const started = performance.now();
    const requestId = validUuid(context.awsRequestId) ? context.awsRequestId.toLowerCase() : randomUUID();
    let sessionId = 'invalid';
    let result = 'INTERNAL_ERROR';
    try {
      const owner: unknown = event.requestContext?.authorizer?.claims?.sub;
      if (!isTerminalOwnerId(owner)) throw new RequestError('UNAUTHENTICATED');
      const pathId: unknown = event.pathParameters?.id;
      if (
        event.httpMethod !== 'POST' ||
        event.resource !== '/v1/sessions/{id}/terminal-tickets' ||
        event.body !== null ||
        !validUuid(pathId)
      ) {
        throw new RequestError('INVALID_REQUEST');
      }
      sessionId = pathId.toLowerCase();
      const issuedAt = now();
      const expiresAt = new Date(issuedAt.getTime() + terminalTicketLifetimeSeconds * 1000).toISOString();
      if (!isTerminalTimestamp(issuedAt.toISOString()) || !isTerminalTimestamp(expiresAt)) {
        throw new Error('Invalid terminal ticket clock');
      }
      const workTimeMs = context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;
      const abortSignal = workTimeMs > 0 ? AbortSignal.timeout(workTimeMs) : AbortSignal.abort();

      for (let attempt = 0; attempt < maximumTicketAttempts; attempt++) {
        abortSignal.throwIfAborted();
        const ticket = newTicket();
        if (!isTerminalTicket(ticket)) throw new Error('Invalid generated terminal ticket');
        const issue = await store.issue(
          { sessionId, ownerId: owner, ticketHash: terminalTicketHash(ticket), expiresAt },
          abortSignal,
        );
        if (issue === 'collision') continue;
        if (issue === 'not_found') throw new RequestError('NOT_FOUND');
        if (issue === 'session_not_ready') throw new RequestError('SESSION_NOT_READY');
        if (issue === 'session_terminal') throw new RequestError('SESSION_TERMINAL');
        if (issue !== 'issued') throw new Error('Invalid terminal ticket issue result');
        const ticketResponse: TerminalTicket = { sessionId, ticket, url: gatewayUrl, expiresAt };
        if (!validTerminalTicket(ticketResponse)) throw new Error('Invalid terminal ticket response');
        result = 'issued';
        return response(200, ticketResponse);
      }
      throw new Error('Terminal ticket collision limit reached');
    } catch (error) {
      const failure = error instanceof RequestError ? error : new RequestError('INTERNAL_ERROR');
      result = failure.code;
      const [statusCode, message] = errors[failure.code];
      return response(statusCode, { code: failure.code, message, requestId });
    } finally {
      try {
        log({
          operation: 'create_terminal_ticket',
          requestId,
          sessionId,
          result,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        /* Logging must not change the response. */
      }
    }
  };
}
