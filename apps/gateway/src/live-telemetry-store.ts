import { QueryCommand, TransactGetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { retryDynamoConflict } from '../../../packages/dynamodb/src/conflict-retry.js';
import {
  commandEvidenceLimits,
  isCommandParserCheckpoint,
  type CommandEvidence,
} from '../../../packages/contracts/private/command-evidence.js';
import {
  isMonitorControlSource,
  isMonitorControlTimestamp,
} from '../../../packages/contracts/private/monitor-control.js';
import {
  isMonitorEvidencePage,
  type MonitorEvidenceEvent,
} from '../../../packages/contracts/private/monitor-evidence.js';
import {
  isMonitorLiveTelemetry,
  monitorLiveTelemetryKey,
  type LiveMetricMessage,
} from '../../../packages/contracts/private/live-telemetry.js';
import { isMonitorRecordingState } from '../../../packages/contracts/private/monitor-persistence.js';
import {
  isTerminalConnectionId,
  isTerminalGeneration,
  isTerminalInputRecord,
  isTerminalSessionId,
  terminalInputKey,
  terminalSessionKey,
} from '../../../packages/contracts/private/terminal-access.js';
import { readCommandPage } from '../../../packages/session/src/command-reader.js';

export interface GatewayLiveTelemetryBinding {
  sessionId: string;
  connectionId: string;
  generation: number;
}

export interface GatewayLiveTelemetryCursor {
  startedAt: string;
  source: string | null;
  monitorSequence: number;
  commandSequence: number;
  metricSequence: number;
}

export type GatewayLiveTimelineEvent = CommandEvidence | MonitorEvidenceEvent;

export type GatewayLiveTelemetryUpdate =
  | {
      type: 'telemetry';
      cursor: GatewayLiveTelemetryCursor;
      metric: LiveMetricMessage | null;
      events: GatewayLiveTimelineEvent[];
    }
  | {
      type: 'terminal';
      status: 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
      reason:
        | 'validators_passed'
        | 'time_limit'
        | 'learner_ended'
        | 'heartbeat_missed'
        | 'environment_exited'
        | 'recorder_unavailable'
        | 'start_failed'
        | null;
    };

export interface GatewayLiveTelemetryStore {
  read(
    binding: GatewayLiveTelemetryBinding,
    cursor?: GatewayLiveTelemetryCursor,
    signal?: AbortSignal,
  ): Promise<GatewayLiveTelemetryUpdate>;
}

export type GatewayLiveTelemetryErrorCode =
  'invalid_config' | 'authorization_failed' | 'replaced' | 'telemetry_unavailable' | 'cancelled';

const messages: Record<GatewayLiveTelemetryErrorCode, string> = {
  invalid_config: 'Live telemetry configuration is invalid.',
  authorization_failed: 'Live telemetry authorization failed.',
  replaced: 'The terminal connection was replaced.',
  telemetry_unavailable: 'Live telemetry is unavailable.',
  cancelled: 'Live telemetry was cancelled.',
};

export class GatewayLiveTelemetryError extends Error {
  constructor(
    readonly code: GatewayLiveTelemetryErrorCode,
    options?: { cause?: unknown },
  ) {
    super(messages[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GatewayLiveTelemetryError';
  }
}

type SessionStatus = 'provisioning' | 'ready' | 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error';
type StatusReason =
  | 'validators_passed'
  | 'time_limit'
  | 'learner_ended'
  | 'heartbeat_missed'
  | 'environment_exited'
  | 'recorder_unavailable'
  | 'start_failed'
  | null;

interface SessionState {
  status: SessionStatus;
  reason: StatusReason;
  readyAt: string | null;
}

const tableNamePattern = /^[A-Za-z0-9_.-]{3,255}$/;
const terminalStatuses = new Set<SessionStatus>(['resolved', 'failed', 'ended', 'abandoned', 'error']);
const statusReasons = new Set<StatusReason>([
  'validators_passed',
  'time_limit',
  'learner_ended',
  'heartbeat_missed',
  'environment_exited',
  'recorder_unavailable',
  'start_failed',
  null,
]);
const maximumMonitorEventsPerPoll = 100;
const maximumTimelineEventsPerPoll = commandEvidenceLimits.maximumPageCommands + maximumMonitorEventsPerPoll;
const maximumTimelineBytesPerPoll = 512 * 1024;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function stopped(signal: AbortSignal | undefined, cause?: unknown): GatewayLiveTelemetryError | undefined {
  return signal?.aborted ? new GatewayLiveTelemetryError('cancelled', { cause: cause ?? signal.reason }) : undefined;
}

function parseSession(value: unknown, sessionId: string): SessionState {
  if (!record(value) || !record(value.view)) throw new GatewayLiveTelemetryError('authorization_failed');
  const view = value.view;
  if (
    view.id !== sessionId ||
    typeof view.status !== 'string' ||
    !['provisioning', 'ready', 'resolved', 'failed', 'ended', 'abandoned', 'error'].includes(view.status) ||
    !statusReasons.has(view.statusReason as StatusReason) ||
    !(view.readyAt === null || isMonitorControlTimestamp(view.readyAt))
  ) {
    throw new GatewayLiveTelemetryError('authorization_failed');
  }
  const status = view.status as SessionStatus;
  const reason = view.statusReason as StatusReason;
  if ((status === 'ready' || terminalStatuses.has(status)) && view.readyAt === null) {
    throw new GatewayLiveTelemetryError('authorization_failed');
  }
  if (status === 'ready' && reason !== null) throw new GatewayLiveTelemetryError('authorization_failed');
  return { status, reason, readyAt: view.readyAt };
}

function validCursor(value: GatewayLiveTelemetryCursor, binding: GatewayLiveTelemetryBinding): boolean {
  return (
    isMonitorControlTimestamp(value.startedAt) &&
    (value.source === null || isMonitorControlSource(value.source)) &&
    Number.isSafeInteger(value.monitorSequence) &&
    value.monitorSequence >= 0 &&
    value.monitorSequence <= 10_000 &&
    Number.isSafeInteger(value.commandSequence) &&
    value.commandSequence >= 0 &&
    value.commandSequence <= commandEvidenceLimits.maximumCommands &&
    Number.isSafeInteger(value.metricSequence) &&
    value.metricSequence >= 0 &&
    value.metricSequence <= value.monitorSequence &&
    isTerminalSessionId(binding.sessionId)
  );
}

function telemetryFailure(cause?: unknown): GatewayLiveTelemetryError {
  return cause instanceof GatewayLiveTelemetryError
    ? cause
    : new GatewayLiveTelemetryError('telemetry_unavailable', { cause });
}

export class DynamoGatewayLiveTelemetryStore implements GatewayLiveTelemetryStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly table: string,
  ) {
    if (!tableNamePattern.test(table)) throw new GatewayLiveTelemetryError('invalid_config');
  }

  async read(
    binding: GatewayLiveTelemetryBinding,
    cursor?: GatewayLiveTelemetryCursor,
    signal?: AbortSignal,
  ): Promise<GatewayLiveTelemetryUpdate> {
    if (
      !isTerminalSessionId(binding.sessionId) ||
      !isTerminalConnectionId(binding.connectionId) ||
      !isTerminalGeneration(binding.generation) ||
      (cursor !== undefined && !validCursor(cursor, binding))
    ) {
      throw new GatewayLiveTelemetryError('invalid_config');
    }
    const cancelled = stopped(signal);
    if (cancelled) throw cancelled;
    const operationSignal = signal ?? new AbortController().signal;
    const snapshot = new TransactGetCommand({
      TransactItems: [
        {
          Get: {
            TableName: this.table,
            Key: terminalSessionKey(binding.sessionId),
            ProjectionExpression: '#data.#view',
            ExpressionAttributeNames: { '#data': 'data', '#view': 'view' },
          },
        },
        { Get: { TableName: this.table, Key: terminalInputKey(binding.sessionId) } },
        { Get: { TableName: this.table, Key: { PK: `SESSION#${binding.sessionId}`, SK: 'RECORDING' } } },
        { Get: { TableName: this.table, Key: { PK: `SESSION#${binding.sessionId}`, SK: 'COMMAND_PARSER' } } },
        { Get: { TableName: this.table, Key: monitorLiveTelemetryKey(binding.sessionId) } },
      ],
    });
    let responses;
    try {
      responses = (
        await retryDynamoConflict(() => this.client.send(snapshot, { abortSignal: operationSignal }), operationSignal)
      ).Responses;
    } catch (cause) {
      const cancelledAfterRead = stopped(signal, cause);
      if (cancelledAfterRead) throw cancelledAfterRead;
      throw telemetryFailure(cause);
    }

    const session = parseSession(responses?.[0]?.Item?.data, binding.sessionId);
    const input = responses?.[1]?.Item?.data;
    if (!isTerminalInputRecord(input, binding.sessionId)) throw new GatewayLiveTelemetryError('replaced');
    if (input.connectionId !== binding.connectionId || input.generation !== binding.generation) {
      throw new GatewayLiveTelemetryError('replaced');
    }
    if (terminalStatuses.has(session.status)) {
      return {
        type: 'terminal',
        status: session.status as Extract<SessionStatus, 'resolved' | 'failed' | 'ended' | 'abandoned' | 'error'>,
        reason: session.reason,
      };
    }
    if (session.status !== 'ready' || session.readyAt === null) {
      throw new GatewayLiveTelemetryError('authorization_failed');
    }

    try {
      const recording = responses?.[2]?.Item?.data;
      const parser = responses?.[3]?.Item?.data;
      const live = responses?.[4]?.Item?.data;
      if (
        !isMonitorRecordingState(recording, binding.sessionId) ||
        recording.status !== 'recording' ||
        recording.startedAt !== session.readyAt ||
        (parser !== undefined && !isCommandParserCheckpoint(parser)) ||
        (live !== undefined &&
          (!isMonitorLiveTelemetry(live, binding.sessionId) ||
            live.startedAt !== session.readyAt ||
            live.source !== recording.source ||
            live.frontier > recording.cursor))
      ) {
        throw telemetryFailure();
      }
      const commandTarget = parser === undefined ? 0 : parser.count - (parser.active === null ? 0 : 1);
      if (cursor === undefined) {
        return {
          type: 'telemetry',
          cursor: {
            startedAt: session.readyAt,
            source: recording.source,
            monitorSequence: recording.cursor,
            commandSequence: commandTarget,
            metricSequence: live?.sequence ?? 0,
          },
          metric: live === undefined ? null : structuredClone(live.metric),
          events: [],
        };
      }
      if (
        cursor.startedAt !== session.readyAt ||
        cursor.commandSequence > commandTarget ||
        cursor.monitorSequence > recording.cursor ||
        (cursor.source === null
          ? cursor.monitorSequence !== 0 || cursor.metricSequence !== 0
          : cursor.source !== recording.source) ||
        (recording.source === null && cursor.source !== null) ||
        (live === undefined ? cursor.metricSequence !== 0 : live.sequence < cursor.metricSequence)
      ) {
        throw telemetryFailure();
      }

      const [commands, monitor] = await Promise.all([
        this.commands(binding.sessionId, cursor.commandSequence, commandTarget, operationSignal),
        this.monitorEvents(binding.sessionId, cursor.source, cursor.monitorSequence, recording.cursor, operationSignal),
      ]);
      const events: GatewayLiveTimelineEvent[] = [
        ...commands.map((value) => structuredClone(value)),
        ...monitor.events,
      ];
      events.sort((left, right) =>
        left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
      if (
        events.length > maximumTimelineEventsPerPoll ||
        new Set(events.map((event) => event.id)).size !== events.length ||
        Buffer.byteLength(JSON.stringify(events)) > maximumTimelineBytesPerPoll
      ) {
        throw telemetryFailure();
      }
      return {
        type: 'telemetry',
        cursor: {
          startedAt: session.readyAt,
          source: recording.source,
          monitorSequence: monitor.nextSequence,
          commandSequence: commands.at(-1)?.seq ?? cursor.commandSequence,
          metricSequence: live?.sequence ?? cursor.metricSequence,
        },
        metric: live !== undefined && live.sequence > cursor.metricSequence ? structuredClone(live.metric) : null,
        events,
      };
    } catch (cause) {
      const cancelledAfterTelemetry = stopped(signal, cause);
      if (cancelledAfterTelemetry) throw cancelledAfterTelemetry;
      throw telemetryFailure(cause);
    }
  }

  private async commands(
    sessionId: string,
    after: number,
    target: number,
    signal: AbortSignal,
  ): Promise<CommandEvidence[]> {
    if (after >= target) return [];
    const values = await readCommandPage(this.client, this.table, sessionId, 'COMMAND', after, target, signal);
    if (!values.length || values.some((value, index) => value.seq !== after + index + 1)) throw telemetryFailure();
    return values;
  }

  private async monitorEvents(
    sessionId: string,
    expectedSource: string | null,
    after: number,
    target: number,
    signal: AbortSignal,
  ): Promise<{ nextSequence: number; events: MonitorEvidenceEvent[] }> {
    if (after >= target) return { nextSequence: after, events: [] };
    if (expectedSource === null && after !== 0) throw telemetryFailure();
    const key = (sequence: number) => `MONITOR_EVENTS#${String(sequence).padStart(6, '0')}`;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: 1,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :low AND :high',
        ExpressionAttributeValues: {
          ':pk': `SESSION#${sessionId}`,
          ':low': key(after + 1),
          ':high': key(target),
        },
      }),
      { abortSignal: signal },
    );
    const row = result.Items?.[0];
    if (
      !row ||
      !isMonitorEvidencePage(row.data) ||
      row.SK !== key(row.data.nextSequence) ||
      row.data.after !== after ||
      row.data.nextSequence > target ||
      (expectedSource !== null && row.data.source !== expectedSource) ||
      row.data.events.length > maximumMonitorEventsPerPoll
    ) {
      throw telemetryFailure();
    }
    return {
      nextSequence: row.data.nextSequence,
      events: row.data.events.map((item) => structuredClone(item.event)),
    };
  }
}
