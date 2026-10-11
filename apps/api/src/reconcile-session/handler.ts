import { performance } from 'node:perf_hooks';
import type { Context, DynamoDBStreamEvent } from 'aws-lambda';
import type { ReconcileResult } from '../session-lifecycle/reconcile.js';
import { validUuid, validTaskArn } from '../start-session/validation.js';
import { sessionLifecycle } from '../../../../packages/contracts/private/session-lifecycle.js';
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export interface ReconcileLog {
  operation: 'reconcile_session';
  sessionId: string;
  result: string;
  durationMs: number;
}
export function createReconcileHandler({
  reconcile,
  taskSession,
  log = () => {},
}: {
  reconcile(id: string, signal?: AbortSignal): Promise<ReconcileResult>;
  taskSession(id: string, cluster: string, task: string, signal?: AbortSignal): Promise<boolean>;
  log?: (value: ReconcileLog) => void;
}) {
  return async (event: unknown, context: Pick<Context, 'getRemainingTimeInMillis'>): Promise<void> => {
    const available = context.getRemainingTimeInMillis() - 1000;
    const signal = available > 0 ? AbortSignal.timeout(available) : AbortSignal.abort();
    signal.throwIfAborted();
    const ids = new Set<string>();
    if (record(event) && Array.isArray(event.Records)) {
      if (event.Records.length > sessionLifecycle.maximumSweepItems)
        throw new Error('Lifecycle event exceeds its bound.');
      for (const item of (event as unknown as DynamoDBStreamEvent).Records) {
        const PK = item.dynamodb?.Keys?.PK?.S;
        const SK = item.dynamodb?.Keys?.SK?.S;
        if (
          item.eventSource !== 'aws:dynamodb' ||
          !PK?.startsWith('SESSION#') ||
          !['STATE', 'LIFECYCLE', 'RECORDING', 'MONITOR_OBSERVATION'].includes(SK ?? '') ||
          item.eventName === 'REMOVE'
        )
          continue;
        const id = PK.slice(8);
        if (!validUuid(id)) throw new Error('Lifecycle stream identity is invalid.');
        ids.add(id.toLowerCase());
      }
    } else if (record(event) && Object.keys(event).length === 1 && validUuid(event.sessionId)) {
      ids.add(event.sessionId.toLowerCase());
    } else if (
      record(event) &&
      event.source === 'aws.ecs' &&
      event['detail-type'] === 'ECS Task State Change' &&
      record(event.detail)
    ) {
      const detail = event.detail;
      if (
        detail.lastStatus !== 'STOPPED' ||
        !validUuid(detail.startedBy) ||
        !validTaskArn(detail.taskArn) ||
        typeof detail.clusterArn !== 'string'
      )
        throw new Error('Lifecycle task event is invalid.');
      if (await taskSession(detail.startedBy.toLowerCase(), detail.clusterArn, detail.taskArn, signal))
        ids.add(detail.startedBy.toLowerCase());
    } else throw new Error('Lifecycle event is invalid.');
    for (const id of ids) {
      const started = performance.now();
      let result = 'failed';
      try {
        result = await reconcile(id, signal);
      } finally {
        try {
          log({
            operation: 'reconcile_session',
            sessionId: id,
            result,
            durationMs: Math.round(performance.now() - started),
          });
        } catch {
          /* Reporting cannot change reconciliation. */
        }
      }
    }
  };
}
