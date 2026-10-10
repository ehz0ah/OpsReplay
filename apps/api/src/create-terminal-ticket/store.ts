import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import {
  GetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  isTerminalOwnerId,
  isTerminalSessionId,
  isTerminalTicketHash,
  isTerminalTicketRecord,
  isTerminalTimestamp,
  terminalSessionKey,
  terminalTicketKey,
  terminalTicketTtlAttribute,
  type TerminalTicketRecord,
} from '../../../../packages/contracts/private/terminal-access.js';
import { sendOptions } from '../shared/aws.js';
import type { SessionRecord } from '../start-session/types.js';
import { validSession, validSessionRelations } from '../start-session/validation.js';

export interface TerminalTicketIssue {
  sessionId: string;
  ownerId: string;
  ticketHash: string;
  expiresAt: string;
}

export type TerminalTicketIssueResult = 'issued' | 'not_found' | 'session_not_ready' | 'session_terminal' | 'collision';

export interface TerminalTicketIssuer {
  issue(request: TerminalTicketIssue, abortSignal?: AbortSignal): Promise<TerminalTicketIssueResult>;
}

const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const terminalStatuses = new Set<SessionRecord['view']['status']>([
  'resolved',
  'failed',
  'ended',
  'abandoned',
  'error',
]);
const maximumTransactionAttempts = 3;
const maximumTransportAttempts = 2;
const definiteDynamoConfigurationErrors = new Set([
  'AccessDeniedException',
  'IdempotentParameterMismatchException',
  'ResourceNotFoundException',
  'ValidationException',
]);

function storedSession(item: Record<string, unknown> | undefined): SessionRecord | undefined {
  if (!item) return undefined;
  if (!validSession(item.data) || !validSessionRelations(item.data)) {
    throw new Error('Invalid stored session record');
  }
  return item.data;
}

function sessionState(
  session: SessionRecord | undefined,
  request: TerminalTicketIssue,
): TerminalTicketIssueResult | 'ready' {
  if (!session || session.ownerId !== request.ownerId || session.view.id !== request.sessionId) return 'not_found';
  if (session.view.status === 'provisioning') return 'session_not_ready';
  if (terminalStatuses.has(session.view.status)) return 'session_terminal';
  if (session.view.status !== 'ready' || session.taskAddress === null) {
    throw new Error('Invalid ready session record');
  }
  return 'ready';
}

function sameTicket(left: TerminalTicketRecord | undefined, right: TerminalTicketRecord): boolean {
  return (
    left?.schemaVersion === right.schemaVersion &&
    left.sessionId === right.sessionId &&
    left.ownerId === right.ownerId &&
    left.expiresAt === right.expiresAt
  );
}

function transactionContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (
    reasons !== undefined &&
    reasons.some((reason) => reason.Code === 'TransactionConflict') &&
    reasons.every((reason) => reason.Code === 'None' || reason.Code === 'TransactionConflict')
  );
}

function definiteDynamoConfigurationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (definiteDynamoConfigurationErrors.has(error.name)) return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.some((reason) => reason.Code === 'ValidationError') ?? false;
}

function validIssue(request: TerminalTicketIssue): boolean {
  const expiresAt = Date.parse(request.expiresAt);
  return (
    isTerminalSessionId(request.sessionId) &&
    isTerminalOwnerId(request.ownerId) &&
    isTerminalTicketHash(request.ticketHash) &&
    isTerminalTimestamp(request.expiresAt) &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > 0
  );
}

export class DynamoTerminalTicketStore implements TerminalTicketIssuer {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!tableNamePattern.test(table)) throw new Error('Invalid terminal ticket table');
  }

  async issue(request: TerminalTicketIssue, abortSignal?: AbortSignal): Promise<TerminalTicketIssueResult> {
    if (!validIssue(request)) throw new Error('Invalid terminal ticket issue');
    abortSignal?.throwIfAborted();
    const initial = sessionState(await this.readSession(request.sessionId, abortSignal), request);
    if (initial !== 'ready') return initial;

    const ticket: TerminalTicketRecord = {
      schemaVersion: 1,
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      expiresAt: request.expiresAt,
    };
    const command = new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        {
          ConditionCheck: {
            TableName: this.table,
            Key: terminalSessionKey(request.sessionId),
            ConditionExpression:
              'attribute_exists(PK) AND #data.#ownerId = :ownerId AND #data.#view.#id = :sessionId AND ' +
              '#data.#view.#status = :ready AND #data.#taskAddress <> :empty',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#ownerId': 'ownerId',
              '#view': 'view',
              '#id': 'id',
              '#status': 'status',
              '#taskAddress': 'taskAddress',
            },
            ExpressionAttributeValues: {
              ':ownerId': request.ownerId,
              ':sessionId': request.sessionId,
              ':ready': 'ready',
              ':empty': null,
            },
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: {
              ...terminalTicketKey(request.sessionId, request.ticketHash),
              data: ticket,
              [terminalTicketTtlAttribute]: Math.floor(Date.parse(request.expiresAt) / 1000),
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
    });

    for (let attempt = 0; attempt < maximumTransactionAttempts; attempt++) {
      for (let transportAttempt = 0; transportAttempt < maximumTransportAttempts; transportAttempt++) {
        try {
          await this.client.send(command, sendOptions(abortSignal));
          return 'issued';
        } catch (error) {
          abortSignal?.throwIfAborted();
          if (definiteDynamoConfigurationFailure(error)) throw error;
          const recovered = await this.recover(request, ticket, abortSignal);
          if (recovered !== 'ready') return recovered;
          if (transactionContention(error)) break;
          if (transportAttempt + 1 < maximumTransportAttempts) continue;
          throw error;
        }
      }
      if (attempt + 1 < maximumTransactionAttempts) {
        await setTimeout(20 * 2 ** attempt, undefined, { signal: abortSignal });
      }
    }
    throw new Error('Terminal ticket transaction contention limit reached');
  }

  private async readSession(sessionId: string, abortSignal?: AbortSignal): Promise<SessionRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.table, Key: terminalSessionKey(sessionId), ConsistentRead: true }),
      sendOptions(abortSignal),
    );
    return storedSession(result.Item);
  }

  private async recover(
    request: TerminalTicketIssue,
    expectedTicket: TerminalTicketRecord,
    abortSignal?: AbortSignal,
  ): Promise<TerminalTicketIssueResult | 'ready'> {
    const result = await this.client.send(
      new TransactGetCommand({
        TransactItems: [
          { Get: { TableName: this.table, Key: terminalSessionKey(request.sessionId) } },
          { Get: { TableName: this.table, Key: terminalTicketKey(request.sessionId, request.ticketHash) } },
        ],
      }),
      sendOptions(abortSignal),
    );
    const session = storedSession(result.Responses?.[0]?.Item);
    const ticketItem = result.Responses?.[1]?.Item;
    const ticketValue = ticketItem?.data;
    if (ticketValue !== undefined && !isTerminalTicketRecord(ticketValue, request.sessionId)) {
      throw new Error('Invalid stored terminal ticket record');
    }
    if (
      sameTicket(ticketValue as TerminalTicketRecord | undefined, expectedTicket) &&
      ticketItem?.[terminalTicketTtlAttribute] === Math.floor(Date.parse(expectedTicket.expiresAt) / 1000)
    ) {
      return 'issued';
    }
    const state = sessionState(session, request);
    if (state !== 'ready') return state;
    return ticketValue === undefined ? 'ready' : 'collision';
  }
}
