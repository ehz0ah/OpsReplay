import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTerminalConnectionId,
  isTerminalGeneration,
  isTerminalInputRecord,
  isTerminalSessionId,
  isTerminalTicket,
  isTerminalTicketRecord,
  isTerminalTimestamp,
  terminalAccessLimits,
  terminalInputKey,
  terminalSessionKey,
  terminalTicketHash,
  terminalTicketKey,
} from './terminal-access.js';

const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ticket = 'q7Xo2m3ZkVdQ8yB1tNcR5wLpE0sHaUfJiGvK4bYx9Tz';
const now = '2026-10-10T08:00:00.000Z';

test('derives stable terminal keys without retaining the raw ticket', () => {
  const hash = terminalTicketHash(ticket);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(terminalSessionKey(sessionId), { PK: `SESSION#${sessionId}`, SK: 'STATE' });
  assert.deepEqual(terminalInputKey(sessionId), { PK: `SESSION#${sessionId}`, SK: 'INPUT' });
  assert.deepEqual(terminalTicketKey(sessionId, hash), {
    PK: `SESSION#${sessionId}`,
    SK: `TICKET#${hash}`,
  });
  assert.equal(JSON.stringify(terminalTicketKey(sessionId, hash)).includes(ticket), false);
});

test('validates terminal identifiers, tickets, timestamps, and generations', () => {
  assert.equal(isTerminalSessionId(sessionId), true);
  assert.equal(isTerminalSessionId(sessionId.toUpperCase()), false);
  assert.equal(isTerminalTicket(ticket), true);
  assert.equal(isTerminalTicket('short'), false);
  assert.equal(isTerminalTicket('x'.repeat(65)), false);
  assert.equal(isTerminalConnectionId('gateway_connection-1'), true);
  assert.equal(isTerminalConnectionId(''), false);
  assert.equal(isTerminalTimestamp(now), true);
  assert.equal(isTerminalTimestamp('2026-10-10T08:00:00Z'), false);
  assert.equal(isTerminalGeneration(1), true);
  assert.equal(isTerminalGeneration(terminalAccessLimits.maximumGeneration), true);
  assert.equal(isTerminalGeneration(0), false);
});

test('validates exact terminal ticket and input records', () => {
  const ticketRecord = { schemaVersion: 1 as const, sessionId, ownerId: 'learner-1', expiresAt: now };
  const inputRecord = {
    schemaVersion: 1 as const,
    sessionId,
    generation: 4,
    connectionId: 'gateway-connection-1',
    claimedAt: now,
  };
  assert.equal(isTerminalTicketRecord(ticketRecord, sessionId), true);
  assert.equal(isTerminalInputRecord(inputRecord, sessionId), true);
  assert.equal(isTerminalTicketRecord({ ...ticketRecord, rawTicket: ticket }, sessionId), false);
  assert.equal(isTerminalInputRecord({ ...inputRecord, generation: 0 }, sessionId), false);
  assert.equal(
    isTerminalInputRecord({ ...inputRecord, sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, sessionId),
    false,
  );
});

test('rejects invalid key and hash inputs', () => {
  assert.throws(() => terminalTicketHash('short'), /ticket is invalid/i);
  assert.throws(() => terminalSessionKey('not-a-session'), /session key is invalid/i);
  assert.throws(() => terminalInputKey('not-a-session'), /input key is invalid/i);
  assert.throws(() => terminalTicketKey(sessionId, 'not-a-hash'), /ticket key is invalid/i);
});
