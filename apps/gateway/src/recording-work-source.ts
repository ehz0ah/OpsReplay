import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import {
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import {
  parseRecordingWorkOrder,
  recordingWorkOrder,
  unfinishedWorkIndex,
  type RecordingWorkIdentity,
} from '../../../packages/contracts/private/recording-work.js';
import { isMonitorControlTimestamp } from '../../../packages/contracts/private/monitor-control.js';
import { isMonitorRecordingSessionId } from './monitor-recording-identity.js';

export interface RecordingWork extends RecordingWorkIdentity {
  taskAddress: string;
  monitorCertificate: string;
  monitorSecret: string;
}

export interface DiscoverRecordingWork {
  limit: number;
  excludedSessionIds: readonly string[];
  now: string;
}

export interface RecordingWorkDiscovery {
  work: RecordingWork[];
  invalidEntries: number;
}

export type RecordingWorkRetirement = 'retired' | 'not_terminal';

export interface RecordingWorkSource {
  discover(value: DiscoverRecordingWork, signal?: AbortSignal): Promise<RecordingWorkDiscovery>;
  retire(value: RecordingWorkIdentity, signal?: AbortSignal): Promise<RecordingWorkRetirement>;
}

export type RecordingWorkSourceErrorCode = 'invalid_config' | 'invalid_input' | 'invalid_store' | 'invalid_state';

const messages: Record<RecordingWorkSourceErrorCode, string> = {
  invalid_config: 'Recording work source configuration is invalid.',
  invalid_input: 'Recording work request is invalid.',
  invalid_store: 'Stored recording work is invalid.',
  invalid_state: 'Recording work source is already reading.',
};

export class RecordingWorkSourceError extends Error {
  constructor(readonly code: RecordingWorkSourceErrorCode) {
    super(messages[code]);
    this.name = 'RecordingWorkSourceError';
  }
}

const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const monitorSecretPattern = /^[A-Za-z0-9_-]{43}$/;
const maximumCertificateBytes = 16_384;
const maximumDiscoveryLimit = 64;
const maximumExcludedSessions = maximumDiscoveryLimit * 2;
const maximumQueryItems = maximumDiscoveryLimit + maximumExcludedSessions;
const serverAuthOid = '1.3.6.1.5.5.7.3.1';
const activeSessionStatuses = new Set(['provisioning', 'ready']);
const terminalSessionStatuses = new Set(['resolved', 'failed', 'ended', 'abandoned', 'error']);
const activeRecordingStatuses = new Set(['pending', 'recording', 'draining']);
const terminalRecordingStatuses = new Set(['complete', 'incomplete']);

type Cursor = QueryCommandOutput['LastEvaluatedKey'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendOptions(signal?: AbortSignal): { abortSignal?: AbortSignal } {
  return signal === undefined ? {} : { abortSignal: signal };
}

function conditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function validCertificate(value: unknown, now: string): value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > maximumCertificateBytes
  ) {
    return false;
  }
  try {
    const certificate = new X509Certificate(value);
    return (
      !certificate.ca &&
      certificate.keyUsage.includes(serverAuthOid) &&
      certificate.subject === certificate.issuer &&
      certificate.publicKey.asymmetricKeyType === 'ec' &&
      certificate.publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
      certificate.verify(certificate.publicKey) &&
      Date.parse(certificate.validFrom) <= Date.parse(now) &&
      Date.parse(certificate.validTo) > Date.parse(now)
    );
  } catch {
    return false;
  }
}

function candidateIdentity(value: unknown): RecordingWorkIdentity {
  if (!record(value)) throw new RecordingWorkSourceError('invalid_store');
  const identity = parseRecordingWorkOrder(value[unfinishedWorkIndex.sortKey]);
  if (
    !identity ||
    value.PK !== `SESSION#${identity.sessionId}` ||
    value.SK !== 'STATE' ||
    value[unfinishedWorkIndex.partitionKey] !== unfinishedWorkIndex.recordingPartition
  ) {
    throw new RecordingWorkSourceError('invalid_store');
  }
  return identity;
}

interface RetirementCondition {
  sessionStatus: string;
  recordingStatus: string;
}

type Inspection =
  { kind: 'work'; work: RecordingWork } | { kind: 'retire'; condition: RetirementCondition } | { kind: 'stale' };

function retirementCondition(value: unknown, identity: RecordingWorkIdentity): RetirementCondition | undefined {
  if (!record(value)) throw new RecordingWorkSourceError('invalid_store');
  const data = value.data;
  if (!record(data)) throw new RecordingWorkSourceError('invalid_store');
  const view = data.view;
  if (
    !record(view) ||
    !record(view.recording) ||
    view.id !== identity.sessionId ||
    !isMonitorControlTimestamp(view.createdAt) ||
    recordingWorkOrder(view.createdAt, identity.sessionId) !== identity.workOrder ||
    typeof view.status !== 'string' ||
    typeof view.recording.status !== 'string'
  ) {
    throw new RecordingWorkSourceError('invalid_store');
  }
  const sessionStatus = view.status;
  const recordingStatus = view.recording.status;
  if (terminalRecordingStatuses.has(recordingStatus)) {
    if (!terminalSessionStatuses.has(sessionStatus)) throw new RecordingWorkSourceError('invalid_store');
    return { sessionStatus, recordingStatus };
  }
  if (recordingStatus === 'pending' && terminalSessionStatuses.has(sessionStatus)) {
    return { sessionStatus, recordingStatus };
  }
  return undefined;
}

function inspectSession(value: unknown, identity: RecordingWorkIdentity, now: string): Inspection {
  if (!record(value)) return { kind: 'stale' };
  if (
    value.PK !== `SESSION#${identity.sessionId}` ||
    value.SK !== 'STATE' ||
    value[unfinishedWorkIndex.partitionKey] !== unfinishedWorkIndex.recordingPartition ||
    value[unfinishedWorkIndex.sortKey] !== identity.workOrder
  ) {
    return { kind: 'stale' };
  }
  const data = value.data;
  if (!record(data)) throw new RecordingWorkSourceError('invalid_store');
  const view = data.view;
  if (!record(view) || !record(view.recording)) throw new RecordingWorkSourceError('invalid_store');
  if (
    view.id !== identity.sessionId ||
    !isMonitorControlTimestamp(view.createdAt) ||
    recordingWorkOrder(view.createdAt, identity.sessionId) !== identity.workOrder ||
    typeof view.status !== 'string' ||
    typeof view.recording.status !== 'string'
  ) {
    throw new RecordingWorkSourceError('invalid_store');
  }
  const sessionStatus = view.status;
  const recordingStatus = view.recording.status;
  if (terminalRecordingStatuses.has(recordingStatus)) {
    if (!terminalSessionStatuses.has(sessionStatus)) throw new RecordingWorkSourceError('invalid_store');
    return { kind: 'retire', condition: { sessionStatus, recordingStatus } };
  }
  if (!activeRecordingStatuses.has(recordingStatus)) throw new RecordingWorkSourceError('invalid_store');

  if (recordingStatus === 'pending') {
    if (terminalSessionStatuses.has(sessionStatus)) {
      return { kind: 'retire', condition: { sessionStatus, recordingStatus } };
    }
    if (sessionStatus !== 'provisioning' || !isMonitorControlTimestamp(data.provisioningDeadline)) {
      throw new RecordingWorkSourceError('invalid_store');
    }
    // The lifecycle expiry action owns the terminal transition. Skipping an overdue
    // provisioning session avoids racing a recorder claim with work retirement.
    if (Date.parse(data.provisioningDeadline) <= Date.parse(now)) return { kind: 'stale' };
  } else if (recordingStatus === 'recording') {
    if (!activeSessionStatuses.has(sessionStatus)) throw new RecordingWorkSourceError('invalid_store');
  } else if (!terminalSessionStatuses.has(sessionStatus)) {
    throw new RecordingWorkSourceError('invalid_store');
  }

  if (
    typeof data.monitorSecret !== 'string' ||
    !monitorSecretPattern.test(data.monitorSecret) ||
    typeof data.taskAddress !== 'string' ||
    isIP(data.taskAddress) !== 4 ||
    !validCertificate(data.monitorCertificate, now)
  ) {
    throw new RecordingWorkSourceError('invalid_store');
  }
  return {
    kind: 'work',
    work: {
      ...identity,
      taskAddress: data.taskAddress,
      monitorCertificate: data.monitorCertificate,
      monitorSecret: data.monitorSecret,
    },
  };
}

export class DynamoRecordingWorkSource implements RecordingWorkSource {
  private cursor: Cursor;
  private reading = false;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!tableNamePattern.test(table)) throw new RecordingWorkSourceError('invalid_config');
  }

  async discover(value: DiscoverRecordingWork, signal?: AbortSignal): Promise<RecordingWorkDiscovery> {
    if (
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > maximumDiscoveryLimit ||
      !isMonitorControlTimestamp(value.now) ||
      value.excludedSessionIds.length > maximumExcludedSessions ||
      new Set(value.excludedSessionIds).size !== value.excludedSessionIds.length ||
      value.excludedSessionIds.some((sessionId) => !isMonitorRecordingSessionId(sessionId))
    ) {
      throw new RecordingWorkSourceError('invalid_input');
    }
    if (this.reading) throw new RecordingWorkSourceError('invalid_state');
    this.reading = true;
    try {
      signal?.throwIfAborted();
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: unfinishedWorkIndex.name,
          KeyConditionExpression: '#workPartition = :recording',
          ExpressionAttributeNames: { '#workPartition': unfinishedWorkIndex.partitionKey },
          ExpressionAttributeValues: { ':recording': unfinishedWorkIndex.recordingPartition },
          Limit: Math.min(maximumQueryItems, value.limit + value.excludedSessionIds.length),
          ScanIndexForward: true,
          ...(this.cursor === undefined ? {} : { ExclusiveStartKey: this.cursor }),
        }),
        sendOptions(signal),
      );
      this.cursor = result.LastEvaluatedKey;
      const excluded = new Set(value.excludedSessionIds);
      const work: RecordingWork[] = [];
      let invalidEntries = 0;
      for (const item of result.Items ?? []) {
        signal?.throwIfAborted();
        let identity: RecordingWorkIdentity;
        try {
          identity = candidateIdentity(item);
        } catch (error) {
          if (!(error instanceof RecordingWorkSourceError) || error.code !== 'invalid_store') throw error;
          invalidEntries++;
          continue;
        }
        if (excluded.has(identity.sessionId)) continue;
        const stored = await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: { PK: `SESSION#${identity.sessionId}`, SK: 'STATE' },
            ConsistentRead: true,
          }),
          sendOptions(signal),
        );
        let inspected: Inspection;
        try {
          inspected = inspectSession(stored.Item, identity, value.now);
        } catch (error) {
          if (!(error instanceof RecordingWorkSourceError) || error.code !== 'invalid_store') throw error;
          invalidEntries++;
          continue;
        }
        if (inspected.kind === 'retire') {
          await this.remove(identity, inspected.condition, signal);
          continue;
        }
        if (inspected.kind === 'work') work.push(inspected.work);
        if (work.length === value.limit) break;
      }
      return { work, invalidEntries };
    } finally {
      this.reading = false;
    }
  }

  async retire(value: RecordingWorkIdentity, signal?: AbortSignal): Promise<RecordingWorkRetirement> {
    if (
      !isMonitorRecordingSessionId(value.sessionId) ||
      parseRecordingWorkOrder(value.workOrder)?.sessionId !== value.sessionId
    ) {
      throw new RecordingWorkSourceError('invalid_input');
    }
    const stored = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: `SESSION#${value.sessionId}`, SK: 'STATE' },
        ConsistentRead: true,
      }),
      sendOptions(signal),
    );
    if (
      !stored.Item ||
      stored.Item[unfinishedWorkIndex.partitionKey] !== unfinishedWorkIndex.recordingPartition ||
      stored.Item[unfinishedWorkIndex.sortKey] !== value.workOrder
    ) {
      return 'retired';
    }
    const condition = retirementCondition(stored.Item, value);
    if (condition === undefined) return 'not_terminal';
    return this.remove(value, condition, signal);
  }

  private async remove(
    value: RecordingWorkIdentity,
    condition: RetirementCondition,
    signal?: AbortSignal,
  ): Promise<RecordingWorkRetirement> {
    const command = new UpdateCommand({
      TableName: this.table,
      Key: { PK: `SESSION#${value.sessionId}`, SK: 'STATE' },
      UpdateExpression: 'REMOVE #workPartition, #workOrder',
      ConditionExpression:
        '#workPartition = :recording AND #workOrder = :workOrder AND ' +
        '#data.#view.#status = :sessionStatus AND #data.#view.#recording.#status = :recordingStatus',
      ExpressionAttributeNames: {
        '#workPartition': unfinishedWorkIndex.partitionKey,
        '#workOrder': unfinishedWorkIndex.sortKey,
        '#data': 'data',
        '#view': 'view',
        '#status': 'status',
        '#recording': 'recording',
      },
      ExpressionAttributeValues: {
        ':recording': unfinishedWorkIndex.recordingPartition,
        ':workOrder': value.workOrder,
        ':sessionStatus': condition.sessionStatus,
        ':recordingStatus': condition.recordingStatus,
      },
    });
    try {
      await this.client.send(command, sendOptions(signal));
      return 'retired';
    } catch (error) {
      if (signal?.aborted) throw error;
      const stored = await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: { PK: `SESSION#${value.sessionId}`, SK: 'STATE' },
          ConsistentRead: true,
        }),
        sendOptions(signal),
      );
      if (
        !stored.Item ||
        stored.Item[unfinishedWorkIndex.partitionKey] !== unfinishedWorkIndex.recordingPartition ||
        stored.Item[unfinishedWorkIndex.sortKey] !== value.workOrder
      ) {
        return 'retired';
      }
      const current = retirementCondition(stored.Item, value);
      if (
        current === undefined ||
        current.sessionStatus !== condition.sessionStatus ||
        current.recordingStatus !== condition.recordingStatus
      ) {
        return 'not_terminal';
      }
      if (conditionalFailure(error)) throw new RecordingWorkSourceError('invalid_state');
      throw error;
    }
  }
}
