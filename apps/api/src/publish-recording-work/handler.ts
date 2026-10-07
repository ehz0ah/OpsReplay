import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { Context } from 'aws-lambda';
import { validTaskArn, validUuid } from '../start-session/validation.js';
import type {
  PublishRecordingWorkResult,
  RecordableTaskObservation,
} from '../session-lifecycle/publish-recording-work.js';

const RESPONSE_MARGIN_MS = 1000;

interface Dependencies {
  publish: (observation: RecordableTaskObservation, abortSignal?: AbortSignal) => Promise<PublishRecordingWorkResult>;
  log?: (entry: PublishRecordingWorkLog) => void;
}

export interface PublishRecordingWorkLog {
  operation: 'publish_recording_work';
  sessionId: string;
  result: PublishRecordingWorkResult | 'failed';
  durationMs: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function observation(event: unknown): RecordableTaskObservation | undefined {
  if (!record(event) || event.source !== 'aws.ecs' || event['detail-type'] !== 'ECS Task State Change') {
    throw new Error('Invalid ECS task-state event');
  }
  const detail = event.detail;
  if (!record(detail)) throw new Error('Invalid ECS task-state event');
  if (detail.lastStatus !== 'RUNNING') return undefined;
  if (!validUuid(detail.startedBy)) return undefined;
  if (!validTaskArn(detail.taskArn) || typeof detail.clusterArn !== 'string') {
    throw new Error('Invalid ECS task-state event');
  }
  if (!Array.isArray(detail.attachments)) throw new Error('Invalid ECS task-state event');
  const addresses = new Set<string>();
  for (const attachment of detail.attachments) {
    if (!record(attachment) || attachment.type !== 'ElasticNetworkInterface' || !Array.isArray(attachment.details)) {
      continue;
    }
    for (const item of attachment.details) {
      if (record(item) && item.name === 'privateIPv4Address' && typeof item.value === 'string') {
        addresses.add(item.value);
      }
    }
  }
  if (addresses.size !== 1) throw new Error('ECS task-state event has no unique private address');
  const [taskAddress] = addresses;
  if (!taskAddress || isIP(taskAddress) !== 4) throw new Error('ECS task-state event has an invalid private address');
  return {
    sessionId: detail.startedBy,
    clusterArn: detail.clusterArn,
    taskArn: detail.taskArn,
    taskAddress,
  };
}

export function createPublishRecordingWorkHandler({ publish, log = () => {} }: Dependencies) {
  return async (event: unknown, context: Pick<Context, 'getRemainingTimeInMillis'>): Promise<void> => {
    const started = performance.now();
    let sessionId = 'invalid';
    let result: PublishRecordingWorkResult | 'failed' = 'failed';
    try {
      const task = observation(event);
      if (!task) {
        result = 'ignored';
        return;
      }
      sessionId = task.sessionId;
      const workTimeMs = context.getRemainingTimeInMillis() - RESPONSE_MARGIN_MS;
      const abortSignal = workTimeMs > 0 ? AbortSignal.timeout(workTimeMs) : AbortSignal.abort();
      result = await publish(task, abortSignal);
    } finally {
      try {
        log({
          operation: 'publish_recording_work',
          sessionId,
          result,
          durationMs: Math.round(performance.now() - started),
        });
      } catch {
        /* Logging must not change lifecycle results. */
      }
    }
  };
}
