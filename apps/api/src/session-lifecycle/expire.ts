import type { EnvironmentPort, LifecycleStorePort } from './ports.js';
import { CleanupPendingError } from './ports.js';

interface Dependencies {
  store: Pick<LifecycleStorePort, 'session' | 'saveTask' | 'markStartFailed' | 'completeStartFailure'>;
  environment: Pick<EnvironmentPort, 'findActive' | 'describe' | 'stop'>;
  now?: () => Date;
}

export function createExpireProvisioning({ store, environment, now = () => new Date() }: Dependencies) {
  return async (sessionId: string, abortSignal?: AbortSignal): Promise<'cleaned' | 'ignored'> => {
    abortSignal?.throwIfAborted();
    let session = await store.session(sessionId, abortSignal);
    if (!session) return 'ignored';
    if (session.provisioningCleanup.status === 'complete') return 'ignored';
    if (session.view.status !== 'provisioning'
      && !(session.view.status === 'error' && session.view.statusReason === 'start_failed')) return 'ignored';

    const clock = now();
    if (clock.getTime() < Date.parse(session.provisioningDeadline)) throw new CleanupPendingError();
    if (session.view.status === 'provisioning') {
      session = await store.markStartFailed(sessionId, clock.toISOString(), abortSignal);
    }

    const { cluster, startedBy } = session.launchArguments;
    const active = await environment.findActive(cluster, startedBy, abortSignal);
    if (!session.taskArn && active.length > 0) {
      session = await store.saveTask(sessionId, active[0]!.taskArn, abortSignal);
    }
    for (const task of active) {
      await environment.stop(cluster, task.taskArn, 'OpsReplay provisioning expired', abortSignal);
    }
    if (active.length > 0) throw new CleanupPendingError();

    if (session.taskArn) {
      const task = await environment.describe(cluster, session.taskArn, abortSignal);
      if (task && task.lastStatus !== 'STOPPED') {
        await environment.stop(cluster, task.taskArn, 'OpsReplay provisioning expired', abortSignal);
        throw new CleanupPendingError();
      }
      if (!task && clock.getTime() < Date.parse(session.launchRecoveryDeadline)) {
        throw new CleanupPendingError();
      }
    } else if (clock.getTime() < Date.parse(session.launchRecoveryDeadline)) {
      // A RunTask response can be lost just before the deadline. Keep the lock while
      // ECS reaches a discoverable state. The launcher request itself has a short timeout.
      throw new CleanupPendingError();
    }

    await store.completeStartFailure(sessionId, clock.toISOString(), abortSignal);
    return 'cleaned';
  };
}
