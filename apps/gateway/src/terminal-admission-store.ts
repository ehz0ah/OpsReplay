import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  BatchGetCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  isTerminalConnectionId,
  isTerminalGeneration,
  isTerminalInputRecord,
  isTerminalOwnerId,
  isTerminalSessionId,
  isTerminalTicket,
  isTerminalTicketRecord,
  isTerminalTimestamp,
  terminalAccessLimits,
  terminalInputKey,
  terminalSessionKey,
  terminalTicketHash,
  terminalTicketKey,
  type TerminalInputRecord,
  type TerminalTicketRecord,
} from '../../../packages/contracts/private/terminal-access.js';

export interface TerminalAdmissionRequest {
  sessionId: string;
  ticket: string;
  connectionId: string;
  now: string;
}

export interface TerminalAdmission {
  sessionId: string;
  taskAddress: string;
  connectionId: string;
  generation: number;
}

export interface TerminalInputAuthorization {
  sessionId: string;
  connectionId: string;
  generation: number;
}

export interface TerminalAdmissionStore {
  admit(request: TerminalAdmissionRequest, signal?: AbortSignal): Promise<TerminalAdmission>;
  authorizeInput(request: TerminalInputAuthorization, signal?: AbortSignal): Promise<void>;
}

export type TerminalAdmissionErrorCode =
  | 'invalid_config'
  | 'invalid_input'
  | 'auth_failed'
  | 'ticket_expired'
  | 'session_not_ready'
  | 'session_terminal'
  | 'replaced'
  | 'generation_exhausted'
  | 'invalid_store'
  | 'contention'
  | 'unavailable'
  | 'cancelled';

const messages: Record<TerminalAdmissionErrorCode, string> = {
  invalid_config: 'Terminal admission configuration is invalid.',
  invalid_input: 'Terminal admission request is invalid.',
  auth_failed: 'Terminal authentication failed.',
  ticket_expired: 'Terminal ticket expired.',
  session_not_ready: 'Terminal session is not ready.',
  session_terminal: 'Terminal session has ended.',
  replaced: 'Terminal connection was replaced.',
  generation_exhausted: 'Terminal input generation is exhausted.',
  invalid_store: 'Stored terminal admission data is invalid.',
  contention: 'Terminal admission could not claim the connection.',
  unavailable: 'Terminal admission storage is unavailable.',
  cancelled: 'Terminal admission was cancelled.',
};

export class TerminalAdmissionError extends Error {
  constructor(
    readonly code: TerminalAdmissionErrorCode,
    options?: { cause?: unknown },
  ) {
    super(messages[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TerminalAdmissionError';
  }
}

interface StoredSession {
  ownerId: string;
  status: 'provisioning' | 'ready' | 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
  taskAddress: string | null;
}

interface AdmissionSnapshot {
  session: StoredSession | undefined;
  ticket: TerminalTicketRecord | undefined;
  input: TerminalInputRecord | undefined;
}

interface PreparedAdmission {
  session: StoredSession;
  ticket: TerminalTicketRecord;
  previousInput: TerminalInputRecord | undefined;
  nextInput: TerminalInputRecord;
}

const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const sessionStatuses = new Set<StoredSession['status']>([
  'provisioning',
  'ready',
  'resolved',
  'failed',
  'ended',
  'abandoned',
  'error',
]);
const terminalStatuses = new Set<StoredSession['status']>(['resolved', 'failed', 'ended', 'abandoned', 'error']);
const maximumClaimAttempts = 3;
const maximumTransportAttempts = 2;
const maximumAuthorizationReadAttempts = 2;
const definiteTransactionErrors = new Set([
  'AccessDeniedException',
  'IdempotentParameterMismatchException',
  'ResourceNotFoundException',
  'ValidationException',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendOptions(signal?: AbortSignal): { abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

function cancelled(signal: AbortSignal | undefined, cause?: unknown): TerminalAdmissionError | undefined {
  return signal?.aborted ? new TerminalAdmissionError('cancelled', { cause: cause ?? signal.reason }) : undefined;
}

function transactionContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return (
    reasons === undefined ||
    reasons.every(
      (reason) =>
        reason.Code === undefined || ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code),
    )
  );
}

function definiteDynamoConfigurationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (definiteTransactionErrors.has(error.name)) return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return reasons?.some((reason) => reason.Code === 'ValidationError') ?? false;
}

function parseSession(value: unknown, sessionId: string): StoredSession | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new TerminalAdmissionError('invalid_store');
  const view = value.view;
  if (
    !record(view) ||
    view.id !== sessionId ||
    typeof view.status !== 'string' ||
    !sessionStatuses.has(view.status as StoredSession['status']) ||
    !isTerminalOwnerId(value.ownerId) ||
    !(value.taskAddress === null || (typeof value.taskAddress === 'string' && isIP(value.taskAddress) === 4))
  ) {
    throw new TerminalAdmissionError('invalid_store');
  }
  return {
    ownerId: value.ownerId,
    status: view.status as StoredSession['status'],
    taskAddress: value.taskAddress,
  };
}

function activeSession(session: StoredSession | undefined): StoredSession {
  if (!session) throw new TerminalAdmissionError('invalid_store');
  if (session.status === 'provisioning') throw new TerminalAdmissionError('session_not_ready');
  if (terminalStatuses.has(session.status)) throw new TerminalAdmissionError('session_terminal');
  if (session.status !== 'ready' || session.taskAddress === null) throw new TerminalAdmissionError('invalid_store');
  return session;
}

function sameTicket(left: TerminalTicketRecord | undefined, right: TerminalTicketRecord): boolean {
  return (
    left?.schemaVersion === right.schemaVersion &&
    left.sessionId === right.sessionId &&
    left.ownerId === right.ownerId &&
    left.expiresAt === right.expiresAt
  );
}

function sameInput(left: TerminalInputRecord | undefined, right: TerminalInputRecord | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.connectionId === right.connectionId &&
    left.claimedAt === right.claimedAt
  );
}

export class DynamoTerminalAdmissionStore implements TerminalAdmissionStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!tableNamePattern.test(table)) throw new TerminalAdmissionError('invalid_config');
  }

  async admit(request: TerminalAdmissionRequest, signal?: AbortSignal): Promise<TerminalAdmission> {
    if (
      !isTerminalSessionId(request.sessionId) ||
      !isTerminalTicket(request.ticket) ||
      !isTerminalConnectionId(request.connectionId) ||
      !isTerminalTimestamp(request.now)
    ) {
      throw new TerminalAdmissionError('invalid_input');
    }
    const ticketHash = terminalTicketHash(request.ticket);
    for (let attempt = 0; attempt < maximumClaimAttempts; attempt++) {
      const stopped = cancelled(signal);
      if (stopped) throw stopped;
      const snapshot = await this.readAvailable(request.sessionId, ticketHash, signal);
      const prepared = this.prepare(request, snapshot);
      const transaction = this.transaction(request, ticketHash, prepared);
      for (let transportAttempt = 0; transportAttempt < maximumTransportAttempts; transportAttempt++) {
        try {
          await this.client.send(transaction, sendOptions(signal));
          return this.result(request, prepared.session.taskAddress!, prepared.nextInput.generation);
        } catch (error) {
          const stoppedAfterSend = cancelled(signal, error);
          if (stoppedAfterSend) throw stoppedAfterSend;
          if (definiteDynamoConfigurationFailure(error)) {
            throw new TerminalAdmissionError('invalid_config', { cause: error });
          }
          if (transactionContention(error)) break;
          const recovery = await this.readAvailable(request.sessionId, ticketHash, signal);
          const recovered = this.recover(request, prepared, recovery);
          if (recovered) return recovered;
          if (
            transportAttempt + 1 < maximumTransportAttempts &&
            sameTicket(recovery.ticket, prepared.ticket) &&
            sameInput(recovery.input, prepared.previousInput)
          ) {
            continue;
          }
          throw new TerminalAdmissionError('unavailable', { cause: error });
        }
      }
    }
    throw new TerminalAdmissionError('contention');
  }

  async authorizeInput(request: TerminalInputAuthorization, signal?: AbortSignal): Promise<void> {
    if (
      !isTerminalSessionId(request.sessionId) ||
      !isTerminalConnectionId(request.connectionId) ||
      !isTerminalGeneration(request.generation)
    ) {
      throw new TerminalAdmissionError('invalid_input');
    }
    const stopped = cancelled(signal);
    if (stopped) throw stopped;
    const snapshot = await this.readAuthorizationAvailable(request.sessionId, signal);
    activeSession(snapshot.session);
    if (snapshot.input?.connectionId !== request.connectionId || snapshot.input.generation !== request.generation) {
      throw new TerminalAdmissionError('replaced');
    }
  }

  private async read(
    sessionId: string,
    ticketHash: string | undefined,
    signal?: AbortSignal,
  ): Promise<AdmissionSnapshot> {
    const keys: { PK: string; SK: string }[] = [terminalSessionKey(sessionId)];
    if (ticketHash !== undefined) keys.push(terminalTicketKey(sessionId, ticketHash));
    keys.push(terminalInputKey(sessionId));
    const result = await this.client.send(
      new TransactGetCommand({
        TransactItems: keys.map((Key) => ({ Get: { TableName: this.table, Key } })),
      }),
      sendOptions(signal),
    );
    const responses = result.Responses ?? [];
    const session = parseSession(responses[0]?.Item?.data, sessionId);
    const ticketIndex = ticketHash === undefined ? -1 : 1;
    const inputIndex = ticketHash === undefined ? 1 : 2;
    const ticketValue = ticketIndex < 0 ? undefined : responses[ticketIndex]?.Item?.data;
    const inputValue = responses[inputIndex]?.Item?.data;
    if (ticketValue !== undefined && !isTerminalTicketRecord(ticketValue, sessionId)) {
      throw new TerminalAdmissionError('invalid_store');
    }
    if (inputValue !== undefined && !isTerminalInputRecord(inputValue, sessionId)) {
      throw new TerminalAdmissionError('invalid_store');
    }
    return {
      session,
      ticket: ticketValue as TerminalTicketRecord | undefined,
      input: inputValue as TerminalInputRecord | undefined,
    };
  }

  private async readAvailable(
    sessionId: string,
    ticketHash: string | undefined,
    signal?: AbortSignal,
  ): Promise<AdmissionSnapshot> {
    try {
      return await this.read(sessionId, ticketHash, signal);
    } catch (cause) {
      if (cause instanceof TerminalAdmissionError) throw cause;
      const stopped = cancelled(signal, cause);
      if (stopped) throw stopped;
      if (definiteDynamoConfigurationFailure(cause)) {
        throw new TerminalAdmissionError('invalid_config', { cause });
      }
      throw new TerminalAdmissionError('unavailable', { cause });
    }
  }

  private async readAuthorization(sessionId: string, signal?: AbortSignal): Promise<AdmissionSnapshot> {
    let keys: { PK: string; SK: string }[] = [terminalSessionKey(sessionId), terminalInputKey(sessionId)];
    const items: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < maximumAuthorizationReadAttempts; attempt++) {
      const result = await this.client.send(
        new BatchGetCommand({
          RequestItems: { [this.table]: { Keys: keys, ConsistentRead: true } },
        }),
        sendOptions(signal),
      );
      for (const item of result.Responses?.[this.table] ?? []) {
        if (!record(item)) throw new TerminalAdmissionError('invalid_store');
        items.push(item);
      }
      const unprocessed = result.UnprocessedKeys?.[this.table]?.Keys ?? [];
      if (unprocessed.length === 0) {
        const partitionKey = `SESSION#${sessionId}`;
        const sessionValue = items.find((item) => item.PK === partitionKey && item.SK === 'STATE')?.data;
        const inputValue = items.find((item) => item.PK === partitionKey && item.SK === 'INPUT')?.data;
        const session = parseSession(sessionValue, sessionId);
        if (inputValue !== undefined && !isTerminalInputRecord(inputValue, sessionId)) {
          throw new TerminalAdmissionError('invalid_store');
        }
        return { session, ticket: undefined, input: inputValue as TerminalInputRecord | undefined };
      }
      if (
        unprocessed.length > 2 ||
        unprocessed.some(
          (key) => !record(key) || key.PK !== `SESSION#${sessionId}` || (key.SK !== 'STATE' && key.SK !== 'INPUT'),
        )
      ) {
        throw new TerminalAdmissionError('invalid_store');
      }
      keys = unprocessed as { PK: string; SK: string }[];
    }
    throw new TerminalAdmissionError('unavailable');
  }

  private async readAuthorizationAvailable(sessionId: string, signal?: AbortSignal): Promise<AdmissionSnapshot> {
    try {
      return await this.readAuthorization(sessionId, signal);
    } catch (cause) {
      if (cause instanceof TerminalAdmissionError) throw cause;
      const stopped = cancelled(signal, cause);
      if (stopped) throw stopped;
      if (definiteDynamoConfigurationFailure(cause)) {
        throw new TerminalAdmissionError('invalid_config', { cause });
      }
      throw new TerminalAdmissionError('unavailable', { cause });
    }
  }

  private prepare(request: TerminalAdmissionRequest, snapshot: AdmissionSnapshot): PreparedAdmission {
    if (!snapshot.ticket) throw new TerminalAdmissionError('auth_failed');
    if (Date.parse(snapshot.ticket.expiresAt) <= Date.parse(request.now)) {
      throw new TerminalAdmissionError('ticket_expired');
    }
    const session = activeSession(snapshot.session);
    if (snapshot.ticket.ownerId !== session.ownerId) throw new TerminalAdmissionError('invalid_store');
    const generation = (snapshot.input?.generation ?? 0) + 1;
    if (generation > terminalAccessLimits.maximumGeneration) {
      throw new TerminalAdmissionError('generation_exhausted');
    }
    return {
      session,
      ticket: snapshot.ticket,
      previousInput: snapshot.input,
      nextInput: {
        schemaVersion: 1,
        sessionId: request.sessionId,
        generation,
        connectionId: request.connectionId,
        claimedAt: request.now,
      },
    };
  }

  private transaction(
    request: TerminalAdmissionRequest,
    ticketHash: string,
    prepared: PreparedAdmission,
  ): TransactWriteCommand {
    const inputWrite: NonNullable<TransactWriteCommandInput['TransactItems']>[number] = {
      Put: {
        TableName: this.table,
        Item: { ...terminalInputKey(request.sessionId), data: prepared.nextInput },
        ConditionExpression:
          prepared.previousInput === undefined ? 'attribute_not_exists(PK)' : '#data = :previousInput',
        ...(prepared.previousInput === undefined
          ? {}
          : {
              ExpressionAttributeNames: { '#data': 'data' },
              ExpressionAttributeValues: { ':previousInput': prepared.previousInput },
            }),
      },
    };
    return new TransactWriteCommand({
      ClientRequestToken: randomUUID(),
      TransactItems: [
        {
          ConditionCheck: {
            TableName: this.table,
            Key: terminalSessionKey(request.sessionId),
            ConditionExpression:
              '#data.#ownerId = :ownerId AND #data.#view.#id = :sessionId AND ' +
              '#data.#view.#status = :ready AND #data.#taskAddress = :taskAddress',
            ExpressionAttributeNames: {
              '#data': 'data',
              '#ownerId': 'ownerId',
              '#view': 'view',
              '#id': 'id',
              '#status': 'status',
              '#taskAddress': 'taskAddress',
            },
            ExpressionAttributeValues: {
              ':ownerId': prepared.session.ownerId,
              ':sessionId': request.sessionId,
              ':ready': 'ready',
              ':taskAddress': prepared.session.taskAddress,
            },
          },
        },
        {
          Delete: {
            TableName: this.table,
            Key: terminalTicketKey(request.sessionId, ticketHash),
            ConditionExpression: '#data = :ticket AND #data.#expiresAt > :now',
            ExpressionAttributeNames: { '#data': 'data', '#expiresAt': 'expiresAt' },
            ExpressionAttributeValues: { ':ticket': prepared.ticket, ':now': request.now },
          },
        },
        inputWrite,
      ],
    });
  }

  private recover(
    request: TerminalAdmissionRequest,
    prepared: PreparedAdmission,
    snapshot: AdmissionSnapshot,
  ): TerminalAdmission | undefined {
    if (
      snapshot.ticket === undefined &&
      snapshot.input?.connectionId === request.connectionId &&
      snapshot.input.generation === prepared.nextInput.generation
    ) {
      const session = activeSession(snapshot.session);
      if (session.ownerId !== prepared.session.ownerId || session.taskAddress !== prepared.session.taskAddress) {
        throw new TerminalAdmissionError('invalid_store');
      }
      return this.result(request, session.taskAddress!, snapshot.input.generation);
    }
    if (snapshot.ticket === undefined) throw new TerminalAdmissionError('auth_failed');
    if (Date.parse(snapshot.ticket.expiresAt) <= Date.parse(request.now)) {
      throw new TerminalAdmissionError('ticket_expired');
    }
    activeSession(snapshot.session);
    return undefined;
  }

  private result(request: TerminalAdmissionRequest, taskAddress: string, generation: number): TerminalAdmission {
    return {
      sessionId: request.sessionId,
      taskAddress,
      connectionId: request.connectionId,
      generation,
    };
  }
}
