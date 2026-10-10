import { createHash } from 'node:crypto';

export const terminalAccessLimits = Object.freeze({
  maximumGeneration: 2 ** 53 - 1,
  minimumTicketCharacters: 43,
  maximumTicketCharacters: 64,
  maximumConnectionIdCharacters: 128,
});

export const terminalTicketTtlAttribute = 'ExpiresAt';

export interface TerminalTicketRecord {
  schemaVersion: 1;
  sessionId: string;
  ownerId: string;
  expiresAt: string;
}

export interface TerminalInputRecord {
  schemaVersion: 1;
  sessionId: string;
  generation: number;
  connectionId: string;
  claimedAt: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownerPattern = /^[A-Za-z0-9_-]{1,128}$/;
const ticketPattern = /^[A-Za-z0-9_-]+$/;
const connectionIdPattern = /^[A-Za-z0-9_-]+$/;
const hashPattern = /^[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function isTerminalSessionId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

export function isTerminalOwnerId(value: unknown): value is string {
  return typeof value === 'string' && ownerPattern.test(value);
}

export function isTerminalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function isTerminalTicket(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= terminalAccessLimits.minimumTicketCharacters &&
    value.length <= terminalAccessLimits.maximumTicketCharacters &&
    ticketPattern.test(value)
  );
}

export function isTerminalTicketHash(value: unknown): value is string {
  return typeof value === 'string' && hashPattern.test(value);
}

export function isTerminalConnectionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= terminalAccessLimits.maximumConnectionIdCharacters &&
    connectionIdPattern.test(value)
  );
}

export function isTerminalGeneration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= terminalAccessLimits.maximumGeneration
  );
}

export function isTerminalTicketRecord(value: unknown, sessionId?: string): value is TerminalTicketRecord {
  return (
    record(value) &&
    exactKeys(value, ['schemaVersion', 'sessionId', 'ownerId', 'expiresAt']) &&
    value.schemaVersion === 1 &&
    isTerminalSessionId(value.sessionId) &&
    (sessionId === undefined || value.sessionId === sessionId) &&
    isTerminalOwnerId(value.ownerId) &&
    isTerminalTimestamp(value.expiresAt)
  );
}

export function isTerminalInputRecord(value: unknown, sessionId?: string): value is TerminalInputRecord {
  return (
    record(value) &&
    exactKeys(value, ['schemaVersion', 'sessionId', 'generation', 'connectionId', 'claimedAt']) &&
    value.schemaVersion === 1 &&
    isTerminalSessionId(value.sessionId) &&
    (sessionId === undefined || value.sessionId === sessionId) &&
    isTerminalGeneration(value.generation) &&
    isTerminalConnectionId(value.connectionId) &&
    isTerminalTimestamp(value.claimedAt)
  );
}

export function terminalTicketHash(ticket: string): string {
  if (!isTerminalTicket(ticket)) throw new TypeError('Terminal ticket is invalid.');
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function terminalTicketKey(sessionId: string, ticketHash: string) {
  if (!isTerminalSessionId(sessionId) || !isTerminalTicketHash(ticketHash)) {
    throw new TypeError('Terminal ticket key is invalid.');
  }
  return { PK: `SESSION#${sessionId}`, SK: `TICKET#${ticketHash}` } as const;
}

export function terminalInputKey(sessionId: string) {
  if (!isTerminalSessionId(sessionId)) throw new TypeError('Terminal input key is invalid.');
  return { PK: `SESSION#${sessionId}`, SK: 'INPUT' } as const;
}

export function terminalSessionKey(sessionId: string) {
  if (!isTerminalSessionId(sessionId)) throw new TypeError('Terminal session key is invalid.');
  return { PK: `SESSION#${sessionId}`, SK: 'STATE' } as const;
}
