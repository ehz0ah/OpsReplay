import { isIP } from 'node:net';
import type { LifecycleStorePort } from './ports.js';
import { validTaskArn, validUuid } from '../start-session/validation.js';

export interface RecordableTaskObservation {
  sessionId: string;
  clusterArn: string;
  taskArn: string;
  taskAddress: string;
}

interface Dependencies {
  store: Pick<LifecycleStorePort, 'session' | 'publishRecordingWork'>;
  now?: () => Date;
}

export type PublishRecordingWorkResult = 'published' | 'ignored';

export function createPublishRecordingWork({ store, now = () => new Date() }: Dependencies) {
  return async (
    observation: RecordableTaskObservation,
    abortSignal?: AbortSignal,
  ): Promise<PublishRecordingWorkResult> => {
    if (
      !validUuid(observation.sessionId) ||
      !validTaskArn(observation.taskArn) ||
      isIP(observation.taskAddress) !== 4
    ) {
      throw new Error('Invalid recordable task observation');
    }
    const session = await store.session(observation.sessionId, abortSignal);
    if (!session || session.view.status !== 'provisioning') return 'ignored';
    if (
      session.launchArguments.cluster !== observation.clusterArn ||
      (session.taskArn !== null && session.taskArn !== observation.taskArn)
    ) {
      throw new Error('Observed ECS task does not match the session launch');
    }
    const observedAt = now().toISOString();
    if (Date.parse(observedAt) >= Date.parse(session.provisioningDeadline)) return 'ignored';
    if (session.monitorCertificate === null) throw new Error('Monitor certificate is not available');
    if (session.taskAddress !== null && session.taskAddress !== observation.taskAddress) {
      throw new Error('Observed ECS task address changed');
    }
    await store.publishRecordingWork(
      observation.sessionId,
      observation.taskArn,
      observation.taskAddress,
      observedAt,
      abortSignal,
    );
    return 'published';
  };
}
