import type { EnvironmentPort, LifecycleStorePort, ProvisioningSchedulePort } from './ports.js';
import { LaunchRejectedError } from './ports.js';

export type ProvisionResult = 'launched' | 'already_launched' | 'expired' | 'terminal' | 'capacity_unavailable';

interface Dependencies {
  store: Pick<LifecycleStorePort, 'session' | 'saveTask' | 'failStartWithoutTask'>;
  schedule: ProvisioningSchedulePort;
  environment: Pick<EnvironmentPort, 'launch' | 'stop'>;
  now?: () => Date;
}

export function createProvisionSession({ store, schedule, environment, now = () => new Date() }: Dependencies) {
  return async (sessionId: string, abortSignal?: AbortSignal): Promise<ProvisionResult> => {
    abortSignal?.throwIfAborted();
    let session = await store.session(sessionId, abortSignal);
    if (!session) throw new Error('Session does not exist');
    if (session.view.status !== 'provisioning') return 'terminal';

    await schedule.ensure(session, now(), abortSignal);
    abortSignal?.throwIfAborted();

    // The schedule call can cross the deadline or race with expiry. Read state again
    // before RunTask so a terminal session never starts a new task.
    session = await store.session(sessionId, abortSignal);
    if (!session) throw new Error('Session does not exist');
    if (session.view.status !== 'provisioning') return 'terminal';
    if (session.taskArn) return 'already_launched';
    if (now().getTime() >= Date.parse(session.provisioningDeadline)) return 'expired';

    let taskArn: string;
    try {
      taskArn = await environment.launch(session.launchArguments, abortSignal);
    } catch (error) {
      if (!(error instanceof LaunchRejectedError)) throw error;
      await store.failStartWithoutTask(sessionId, now().toISOString(), abortSignal);
      return 'capacity_unavailable';
    }

    const saved = await store.saveTask(sessionId, taskArn, abortSignal);
    if (saved.view.status !== 'provisioning'
      || now().getTime() >= Date.parse(saved.provisioningDeadline)) {
      await environment.stop(saved.launchArguments.cluster, taskArn, 'OpsReplay provisioning expired', abortSignal);
      return 'expired';
    }
    return 'launched';
  };
}
