import type { SessionRecord } from '../start-session/types.js';
import type { EnvironmentPort, LifecycleStorePort, MonitorBootstrapPort, ProvisioningSchedulePort } from './ports.js';
import { LaunchRejectedError } from './ports.js';

export type ProvisionResult = SessionRecord;

interface Dependencies {
  store: Pick<LifecycleStorePort, 'session' | 'saveMonitorCertificate' | 'saveTask' | 'failStartWithoutTask'>;
  schedule: ProvisioningSchedulePort;
  bootstrap: MonitorBootstrapPort;
  environment: Pick<EnvironmentPort, 'launch' | 'stop'>;
  now?: () => Date;
}

export function createProvisionSession({
  store,
  schedule,
  bootstrap,
  environment,
  now = () => new Date(),
}: Dependencies) {
  return async (sessionId: string, abortSignal?: AbortSignal): Promise<ProvisionResult> => {
    abortSignal?.throwIfAborted();
    let session = await store.session(sessionId, abortSignal);
    if (!session) throw new Error('Session does not exist');
    if (session.view.status !== 'provisioning') return session;

    await schedule.ensure(session, now(), abortSignal);
    abortSignal?.throwIfAborted();
    if (!session.taskArn && now().getTime() < Date.parse(session.provisioningDeadline)) {
      const certificate = await bootstrap.ensure(session, abortSignal);
      session = await store.saveMonitorCertificate(sessionId, certificate, abortSignal);
    }

    // External setup can cross the deadline or race with expiry. Read state again
    // before RunTask so a terminal session never starts a new task.
    session = await store.session(sessionId, abortSignal);
    if (!session) throw new Error('Session does not exist');
    if (
      session.view.status !== 'provisioning' ||
      session.taskArn ||
      now().getTime() >= Date.parse(session.provisioningDeadline)
    )
      return session;

    let taskArn: string;
    try {
      taskArn = await environment.launch(session.launchArguments, abortSignal);
    } catch (error) {
      if (!(error instanceof LaunchRejectedError)) throw error;
      return store.failStartWithoutTask(sessionId, now().toISOString(), error.failure, abortSignal);
    }

    const saved = await store.saveTask(sessionId, taskArn, abortSignal);
    if (saved.view.status !== 'provisioning' || now().getTime() >= Date.parse(saved.provisioningDeadline)) {
      await environment.stop(saved.launchArguments.cluster, taskArn, 'OpsReplay provisioning expired', abortSignal);
    }
    return saved;
  };
}
