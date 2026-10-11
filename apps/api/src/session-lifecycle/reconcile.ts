import type { SessionRecord } from '../start-session/types.js';
import type { LifecycleStorePort, EnvironmentPort } from './ports.js';
import { DynamoAttemptStore } from '../../../../packages/session/src/attempt-store.js';
import { sessionLifecycle } from '../../../../packages/contracts/private/session-lifecycle.js';

export interface SessionDeadlinePort {
  ensure(session: SessionRecord, now: Date, signal?: AbortSignal): Promise<void>;
  delete(session: SessionRecord, signal?: AbortSignal): Promise<void>;
}
export type ReconcileResult = 'ignored' | 'active' | 'draining' | 'cleanup_pending' | 'cleaned';
export function createReconcileSession({
  sessions,
  attempts,
  environment,
  schedules,
  provision,
  publish,
  now = () => new Date(),
}: {
  sessions: Pick<LifecycleStorePort, 'session' | 'saveTask'>;
  attempts: Pick<
    DynamoAttemptStore,
    'session' | 'lifecycle' | 'outcome' | 'observe' | 'incomplete' | 'cleanup' | 'completeNeverReady'
  >;
  environment: Pick<EnvironmentPort, 'findActive' | 'describe' | 'stop'>;
  schedules: SessionDeadlinePort;
  provision?(id: string, signal?: AbortSignal): Promise<SessionRecord>;
  publish?(
    observation: import('./publish-recording-work.js').RecordableTaskObservation,
    signal?: AbortSignal,
  ): Promise<'published' | 'ignored'>;
  now?: () => Date;
}) {
  return async (id: string, signal?: AbortSignal): Promise<ReconcileResult> => {
    signal?.throwIfAborted();
    let session = await sessions.session(id, signal);
    if (!session) return 'ignored';
    const clock = now();
    const at = clock.toISOString();
    if (session.view.status === 'provisioning') {
      if (at < session.provisioningDeadline) {
        if (provision) session = await provision(id, signal);
        if (session.view.status === 'provisioning' && session.taskArn && publish) {
          const task = await environment.describe(session.launchArguments.cluster, session.taskArn, signal);
          if (task?.lastStatus === 'RUNNING' && task.taskAddress)
            await publish(
              {
                sessionId: id,
                clusterArn: session.launchArguments.cluster,
                taskArn: session.taskArn,
                taskAddress: task.taskAddress,
              },
              signal,
            );
        }
        return 'active';
      }
      await attempts.outcome(id, 'error', 'start_failed', at, signal);
      session = await sessions.session(id, signal);
      if (!session) return 'ignored';
    }
    if (session.view.status === 'ready') {
      // Replay a durably saved metric before applying timeout or loss policies.
      // The page may have committed just before its Gateway callback failed.
      await attempts.observe(id, at, signal);
      session = await sessions.session(id, signal);
      if (!session) return 'ignored';
    }
    if (session.view.status === 'ready') {
      const state = await attempts.lifecycle(id, signal);
      if (!state || !state.lastSeenAt || !state.lastMonitorAt || !session.view.endsAt)
        throw new Error('Ready lifecycle state is invalid.');
      const task = session.taskArn
        ? await environment.describe(session.launchArguments.cluster, session.taskArn, signal)
        : undefined;
      if (at >= session.view.endsAt) {
        await attempts.outcome(id, 'failed', 'time_limit', session.view.endsAt, signal, undefined, undefined, at);
      } else if (task?.lastStatus === 'STOPPED') {
        await attempts.outcome(id, 'error', 'environment_exited', at, signal);
      } else if (Date.parse(at) - Date.parse(state.lastSeenAt) >= sessionLifecycle.heartbeatTimeoutMs) {
        await attempts.outcome(
          id,
          'abandoned',
          'heartbeat_missed',
          at,
          signal,
          undefined,
          undefined,
          at,
          undefined,
          state,
        );
      } else if (Date.parse(at) - Date.parse(state.lastMonitorAt) >= sessionLifecycle.monitorTimeoutMs) {
        await attempts.outcome(
          id,
          'error',
          'environment_exited',
          at,
          signal,
          undefined,
          undefined,
          at,
          undefined,
          state,
        );
      } else {
        await schedules.ensure(session, clock, signal);
        // Timer repair can race with an outcome and completed cleanup.
        const saved = await sessions.session(id, signal);
        if (saved && saved.view.status !== 'ready' && (await attempts.lifecycle(id, signal))?.schedulesDeleted)
          await schedules.delete(saved, signal);
        return 'active';
      }
      session = await sessions.session(id, signal);
      if (!session) return 'ignored';
    }
    if (session.view.status === 'provisioning' || session.view.status === 'ready') return 'active';
    const lifecycle = await attempts.lifecycle(id, signal);
    if (!lifecycle) {
      if (session.provisioningCleanup.status === 'complete') return 'cleaned';
      throw new Error('Lifecycle discovery state is missing.');
    }
    if (session.view.recording.status === 'draining') {
      const task = session.taskArn
        ? await environment.describe(session.launchArguments.cluster, session.taskArn, signal)
        : undefined;
      if (task?.lastStatus === 'STOPPED') await attempts.incomplete(id, 'task_lost', at, signal);
      else if (lifecycle.drainDeadlineAt !== null && at >= lifecycle.drainDeadlineAt)
        await attempts.incomplete(id, 'drain_timeout', at, signal);
      else return 'draining';
      session = await sessions.session(id, signal);
      if (!session) return 'ignored';
    }
    if (session.view.readyAt !== null && !['complete', 'incomplete'].includes(session.view.recording.status))
      throw new Error('Terminal recording state is invalid.');
    if (lifecycle.taskStoppedAt === null) {
      const active = await environment.findActive(
        session.launchArguments.cluster,
        session.launchArguments.startedBy,
        signal,
      );
      if (!session.taskArn && active.length > 0) session = await sessions.saveTask(id, active[0]!.taskArn, signal);
      for (const task of active)
        await environment.stop(session.launchArguments.cluster, task.taskArn, 'OpsReplay attempt completed', signal);
      if (active.length > 0) return 'cleanup_pending';
      if (session.taskArn) {
        const task = await environment.describe(session.launchArguments.cluster, session.taskArn, signal);
        // Absence is not STOPPED confirmation. Keep known-task cleanup pending.
        if (!task) return 'cleanup_pending';
        if (task.lastStatus !== 'STOPPED') {
          await environment.stop(
            session.launchArguments.cluster,
            session.taskArn,
            'OpsReplay attempt completed',
            signal,
          );
          return 'cleanup_pending';
        }
      } else if (at < session.launchRecoveryDeadline && session.provisioningCleanup.status !== 'complete')
        return 'cleanup_pending';
      await attempts.cleanup(id, at, false, signal);
    }
    await schedules.delete(session, signal);
    await attempts.cleanup(id, at, true, signal);
    if (session.view.readyAt === null) await attempts.completeNeverReady(id, at, signal);
    return 'cleaned';
  };
}
